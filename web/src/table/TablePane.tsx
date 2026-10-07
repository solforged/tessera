import { For, Show, createEffect, createMemo, createResource, createRoot, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { ulid } from 'ulid';
import { api } from '../api/client';
import type { FieldDefinition, FieldKind, Fields, FieldValue, Operation, Query, QueryResult, QueryRow, SortKey, Type, View } from '../api/types';
import type { Edit, NotebookClient, PageDocument } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { BlockText, plainText } from '../outline/BlockText';
import type { OpenTarget, PaneId, TableViewState } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { kindLabels, partialDatePlaceholder } from '../fields/kinds';
import { FilterPopup } from './FilterPopup';
import { addFilter, chooseSort, copyQuery, fieldEntryId, fieldEntryText, filterLabel, queriesEqual, removeFilter, removeSort, sortLabel } from './query';
import { sourceText } from './sources';
import type { TableSource } from './sources';
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
  | { kind: 'columns'; anchor: HTMLElement }
  | { kind: 'sources'; anchor: HTMLElement; label: string; sources: TableSource[] }
  | null;
const valuePlaceholders: Partial<Record<FieldKind, string>> = { date: partialDatePlaceholder, url: 'https://', identifier: 'ISBN, DOI or arXiv ID' };
const titleWidthLimits = { min: 170, max: 340, default: 240 };
const clampTitleWidth = (width: number | undefined) => Number.isFinite(width) ? Math.max(titleWidthLimits.min, Math.min(titleWidthLimits.max, width!)) : titleWidthLimits.default;

export function TablePane(props: TablePaneProps) {
  const [query, setQuery] = createSignal(copyQuery(props.view.query));
  const [search, setSearch] = createSignal(query().text ?? '');
  const [hiddenFields, setHiddenFields] = createSignal([...(props.view.hiddenFields ?? [])]);
  const [titleWidth, setTitleWidth] = createSignal(clampTitleWidth(props.view.titleWidth));
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
  // Scroll position reaches pane history once per frame, not once per scroll event.
  let scrollReport = 0;
  onCleanup(() => cancelAnimationFrame(scrollReport));
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
  const visibleColumns = createMemo(() => (result()?.columns ?? []).filter(id => !hiddenFields().includes(id)));
  const stretchColumn = createMemo(() => {
    const columns = visibleColumns();
    for (let index = columns.length - 1; index >= 0; index--) {
      const kind = fieldById(columns[index]!)?.kind;
      if (kind === 'text' || kind === 'url') return columns[index];
    }
    return columns.at(-1);
  });
  const columnWidth = (id: string) => {
    const kind = fieldById(id)?.kind;
    return kind === 'text' || kind === 'url' ? 'var(--table-source-width)' : kind === 'number' || kind === 'checkbox' || kind === 'date' ? 'var(--table-compact-width)' : 'var(--table-field-width)';
  };
  let previousColumns: string[] = [];
  createEffect(() => {
    const columns = visibleColumns(); const rowCount = result()?.rows.length ?? 0;
    const current = untrack(focused); const field = previousColumns[current.column - 1];
    const column = current.column === 0 ? 0 : field ? Math.max(0, columns.indexOf(field) + 1) : Math.min(current.column, columns.length);
    if (current.column !== column || current.row >= rowCount) setFocused({ row: Math.max(0, Math.min(current.row, rowCount - 1)), column });
    previousColumns = columns;
  });
  const reportView = (value = query()) => props.onViewChange({
    query: copyQuery(value), scroll: scroll?.scrollTop ?? props.view.scroll,
    hiddenFields: [...hiddenFields()], titleWidth: titleWidth(), horizontalScroll: scroll?.scrollLeft ?? props.view.horizontalScroll ?? 0,
  });
  const showField = (id: string, visible: boolean) => {
    setHiddenFields(values => visible ? values.filter(value => value !== id) : values.includes(id) ? values : [...values, id]);
    reportView();
  };
  const changed = () => !!saved() && !queriesEqual(query(), saved()!.query);
  const title = () => type()?.page.text ?? props.notebook.lookup(query().type ?? '')()?.text ?? '';
  const updateQuery = (next: Query) => {
    setQuery(copyQuery(next));
    reportView(next);
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
            requestAnimationFrame(() => { if (scroll) { scroll.scrollTop = props.view.scroll; scroll.scrollLeft = props.view.horizontalScroll ?? 0; } });
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
        { label: 'Hide column', action: () => showField(field.id, false) },
        { label: 'Edit field…', section: 'Definition', action: () => { anchor.focus({ preventScroll: true }); setPopup({ kind: 'menu', anchor, label: `Edit ${field.name}`, items: [
          ...Object.entries(kindLabels).map(([kind, label], index): MenuItem => ({ label, section: index === 0 ? 'Field kind' : undefined, icon: field.kind === kind ? 'check' : undefined, action: () => { void withDocument(definitions()!.page_id, doc => { const result = doc.edit({ kind: 'fieldKind', definition: field, value: kind as FieldKind }); if (!result.ok) throw new Error(result.reason); }).catch(message); } })),
          ...(query().type && type()?.fields.includes(field.id) ? [{ label: 'Remove from template', section: 'Type template', icon: 'close' as const, action: () => { const current = type()!; void submit({ op: 'set_type_fields', type_id: current.page.id, base_revision: current.page.revision, fields: current.fields.filter(id => id !== field.id) }).catch(message); } }] : []),
        ] }); } },
      ] : []),
    ] });
  };
  const addColumnMenu = (anchor: HTMLElement) => {
    anchor.focus({ preventScroll: true });
    setPopup({ kind: 'menu', anchor, label: 'Add field to type template', items: [
      ...fields().filter(field => !type()?.fields.includes(field.id)).map((field): MenuItem => ({ label: field.name, disabledReason: !query().type ? 'Open a type to add fields' : undefined, action: () => { void appendField(field.id).catch(message); } })),
      { label: 'New field…', disabledReason: !query().type ? 'Open a type to add fields' : undefined, action: () => { anchor.focus({ preventScroll: true }); setPopup({ kind: 'name', anchor, action: 'field', addColumn: true }); } },
    ] });
  };
  const sortMenu = (anchor: HTMLElement) => setPopup({ kind: 'menu', anchor, label: 'Sort', items: [
    ...(['title', 'created', 'updated'] as const).map((by): MenuItem => ({ label: { title: 'Title', created: 'Created', updated: 'Updated' }[by], action: () => updateQuery(chooseSort(query(), { by, field: null })) })),
    ...(result()?.columns ?? []).map(id => ({ label: fieldById(id)?.name ?? id, action: () => updateQuery(chooseSort(query(), { by: 'field', field: id })) })),
  ] });
  const openRow = (row: QueryRow, beside: boolean) => props.onOpen({ kind: 'page', pageId: row.block.page.id, ...(row.block.block.kind === 'block' ? { blockId: row.block.block.id } : {}) }, beside);
  const openField = (row: QueryRow, field: FieldDefinition) => {
    void withDocument(row.block.page.id, doc => {
      const owner = row.block.block;
      const entries = doc.outline.children(owner.id).filter(id => fieldEntryId(doc.block(id)?.text ?? '') === field.id && !doc.block(id)?.archived);
      props.onOpen({ kind: 'page', pageId: owner.page_id, blockId: entries.length === 1 ? entries[0] : owner.kind === 'block' ? owner.id : undefined }, true);
    }).catch(message);
  };
  const startEdit = (row: QueryRow, field: FieldDefinition) => {
    const values = row.values[field.id] ?? [];
    if (!['text', 'number', 'date', 'url', 'identifier'].includes(field.kind) || values.length > 1 || values.some(value => textTokens(value.text).some(token => token.kind === 'reference' || token.kind === 'tag'))) {
      openField(row, field);
      return;
    }
    setEditing({ row, field, text: values[0]?.text ?? '' });
  };
  const commitEdit = async () => {
    const current = editing(); if (!current) return;
    setEditing(null);
    const original = current.row.values[current.field.id]?.[0]?.text ?? '';
    if (current.text === original) return;
    try {
      await withDocument(current.row.block.page.id, doc => {
        const first = current.row.values[current.field.id]?.[0];
        const apply = (edit: Edit) => { const value = doc.edit(edit); if (!value.ok) throw new Error(value.reason); return value; };
        if (first) {
          apply({ kind: 'text', id: first.id, text: current.text });
        } else {
          const owner = current.row.block.block.id;
          let entryId = doc.outline.children(owner).find(id => fieldEntryId(doc.block(id)?.text ?? '') === current.field.id && !doc.block(id)?.archived);
          if (!entryId) entryId = apply({ kind: 'insert', parentId: owner, after: doc.outline.children(owner).at(-1) ?? null, text: fieldEntryText(current.field.id) }).created[0]!;
          const blank = doc.outline.children(entryId).find(id => { const block = doc.block(id); return block && !block.archived && !block.text.trim(); });
          if (blank) apply({ kind: 'text', id: blank, text: current.text });
          else apply({ kind: 'insert', parentId: entryId, after: null, text: current.text });
        }
      });
    } catch (reason) { message(reason); }
    requestAnimationFrame(() => region?.querySelector<HTMLElement>(`[data-row="${focused().row}"][data-column="${focused().column}"]`)?.focus());
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.target instanceof HTMLElement && event.target.closest('input, select, textarea, button, a')) return;
    const current = focused(); const row = result()?.rows[current.row];
    if (event.key === 'Escape') { region.focus(); event.preventDefault(); return; }
    if (event.key === 'Enter' && row) {
      if (!current.column) openRow(row, event.shiftKey);
      else { const field = fieldById(visibleColumns()[current.column - 1]!); if (field) startEdit(row, field); }
      event.preventDefault(); return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const next = { row: Math.max(0, Math.min((result()?.rows.length ?? 1) - 1, current.row + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))), column: Math.max(0, Math.min(visibleColumns().length, current.column + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0))) };
    setFocused(next); region.querySelector<HTMLElement>(`[data-row="${next.row}"][data-column="${next.column}"]`)?.focus(); event.preventDefault();
  };
  onMount(() => { if (props.active) region.focus({ preventScroll: true }); });
  return <div ref={region} class="table-pane" style={{ '--table-title-width': `${titleWidth()}px`, '--table-width': `calc(${titleWidth()}px + ${visibleColumns().map(columnWidth).join(' + ') || '0px'} + var(--space-32))` }} tabIndex={0} role="region" aria-label="Table" onFocusIn={props.onActivate} onPointerDown={props.onActivate} onKeyDown={keydown}>
    <header class="table-header">
      <div class="table-heading">
        <div class="table-register-label"><Show when={query().type}><Button class="table-type-label" onClick={event => props.onOpen({ kind: 'page', pageId: query().type! }, event.shiftKey)}>{title()}</Button><span aria-hidden="true"> / </span></Show><span>Register</span>
          <Show when={props.target.viewId && saved()}><span class="table-view-status">{changed() ? 'Unsaved changes' : 'Saved view'}</span></Show>
        </div>
        <h1><Button class="table-title" label="Views" aria-haspopup="menu" onClick={event => viewMenu(event.currentTarget)}><span>{saved()?.name ?? (title() || 'All blocks')}</span><Icon name="down" /></Button></h1>
      </div>
      <Button class="table-columns-button" aria-haspopup="dialog" aria-expanded={popup()?.kind === 'columns'} onClick={event => setPopup(popup()?.kind === 'columns' ? null : { kind: 'columns', anchor: event.currentTarget })}>Columns <Icon name="down" /></Button>
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
    <div ref={scroll} class="table-scroll" onScroll={() => { cancelAnimationFrame(scrollReport); scrollReport = requestAnimationFrame(() => reportView()); }}>
      <table class="type-table" classList={{ 'table-title-only': !visibleColumns().length }} role="grid"><colgroup><col style={{ width: 'var(--table-title-width)' }} /><For each={visibleColumns()}>{id => <col style={{ width: id === stretchColumn() ? undefined : columnWidth(id) }} />}</For><col style={{ width: 'var(--space-32)' }} /></colgroup>
        <thead><tr><th scope="col" class="table-title-column"><Button aria-haspopup="menu" onClick={event => columnMenu(event.currentTarget, undefined)}>Title</Button></th>
        <For each={visibleColumns()}>{id => <th scope="col"><Button aria-haspopup="menu" onClick={event => columnMenu(event.currentTarget, fieldById(id))}>{fieldById(id)?.name ?? id}</Button></th>}</For>
        <th class="table-add-column"><Button label="Add field to type template" aria-haspopup="menu" title={!query().type ? 'Open a type to add fields' : undefined} onClick={event => addColumnMenu(event.currentTarget)}>+</Button></th>
      </tr></thead><tbody><For each={result()?.rows ?? []}>{(row, rowIndex) => <tr>
        <td class="table-title-column table-cell" data-row={rowIndex()} data-column={0} tabIndex={focused().row === rowIndex() && focused().column === 0 ? 0 : -1} onFocus={() => setFocused({ row: rowIndex(), column: 0 })} onClick={event => openRow(row, event.shiftKey)}>
          <TableCellText>{expanded => <><BlockText text={preview(props.notebook.lookup(row.block.block.id)()?.text ?? row.block.block.text, expanded)} notebook={props.notebook} interactive={false} />
            <Show when={row.block.block.id !== row.block.page.id}><div class="table-page-title">{row.block.page.text}</div></Show>
          </>}</TableCellText>
        </td>
        <For each={visibleColumns()}>{(id, columnIndex) => {
          const field = () => fieldById(id); const current = () => editing();
          return <td class={`table-cell ${field()?.kind === 'number' ? 'table-number' : ''}`} data-row={rowIndex()} data-column={columnIndex() + 1} tabIndex={focused().row === rowIndex() && focused().column === columnIndex() + 1 ? 0 : -1} onFocus={() => setFocused({ row: rowIndex(), column: columnIndex() + 1 })} onDblClick={() => { if (field()) startEdit(row, field()!); }}>
            <Show when={current()?.row.block.block.id === row.block.block.id && current()?.field.id === id} fallback={<TableFieldValue field={field()} values={row.values[id] ?? []} notebook={props.notebook} onSources={(anchor, sources) => setPopup({ kind: 'sources', anchor, label: field()?.name ?? 'Sources', sources })} />}>
              <input class="input table-cell-input" type="text" aria-label={`Edit ${field()?.name ?? 'field'} value`} placeholder={field() ? valuePlaceholders[field()!.kind] : undefined} inputmode={field()?.kind === 'number' ? 'decimal' : field()?.kind === 'url' ? 'url' : undefined} value={current()?.text ?? ''} ref={input => queueMicrotask(() => { input.focus(); input.select(); })} onInput={event => { const text = event.currentTarget.value; setEditing(value => value ? { ...value, text } : null); }} onKeyDown={event => {
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
      {state.kind === 'columns' && <Popup anchor={state.anchor} label="Columns" class="table-columns-popup" onDismiss={() => setPopup(null)} width={280}>
        <div class="table-popup-heading">Columns</div><div class="table-popup-note">Visibility in this register</div>
        <div class="table-column-choice table-column-fixed"><Icon name="check" />Title<span class="table-column-fixed-note">Always visible</span></div>
        <For each={result()?.columns ?? []}>{id => <label class="table-column-choice"><input type="checkbox" checked={!hiddenFields().includes(id)} onChange={event => showField(id, event.currentTarget.checked)} />{fieldById(id)?.name ?? id}</label>}</For>
        <label class="table-width-control" for={`table-title-width-${props.pane}`}><span>Title width <output>{titleWidth()} px</output></span><input id={`table-title-width-${props.pane}`} type="range" min={titleWidthLimits.min} max={titleWidthLimits.max} value={titleWidth()} onInput={event => { setTitleWidth(clampTitleWidth(event.currentTarget.valueAsNumber)); reportView(); }} /></label>
        <div class="table-template-actions"><Button disabled={!query().type} title={!query().type ? 'Open a type to add fields' : undefined} onClick={() => addColumnMenu(state.anchor)}>Add field to type template…</Button></div>
      </Popup>}
      {state.kind === 'sources' && <SourcesPopup anchor={state.anchor} label={state.label} sources={state.sources} notebook={props.notebook} onDismiss={() => setPopup(null)} />}
    </>}</Show>
  </div>;
}

function TableFieldValue(props: { field: FieldDefinition | undefined; values: FieldValue[]; notebook: NotebookClient; onSources(anchor: HTMLElement, sources: TableSource[]): void }) {
  const parsed = createMemo(() => props.field?.kind === 'url' || props.field?.kind === 'text' ? props.values.map(value => ({ value, ...sourceText(value.text) })) : []);
  const sources = createMemo(() => parsed().flatMap(value => value.sources));
  const problems = createMemo(() => props.values.flatMap(value => value.reading.ok ? [] : [value.reading.problem]).join('; '));
  return <Show when={sources().length} fallback={<TableCellText>{expanded => <For each={props.values}>{(value, index) => <>
    {index() > 0 ? ', ' : ''}<Show when={value.reading.ok} fallback={<span class="table-reading-problem" title={!value.reading.ok ? value.reading.problem : undefined}><BlockText text={preview(value.text, expanded)} notebook={props.notebook} interactive={false} /></span>}>
      <span class={props.field?.kind === 'choice' || props.field?.kind === 'instance' ? 'table-value-pill' : ''}><BlockText text={value.reading.ok ? props.field?.kind === 'text' ? preview(value.text, expanded) : props.field?.kind === 'checkbox' ? value.reading.value ? '☑' : '☐' : String(value.reading.value) : ''} notebook={props.notebook} interactive={false} /></span>
    </Show>
  </>}</For>}</TableCellText>}>
    <div class="table-source-cell">
      <Show keyed when={sources()[0]}>{source => <div class="table-source-summary">
        <div class="table-source-label" classList={{ 'table-reading-problem': !!problems() }} title={problems() || plainText(source.label, props.notebook.lookup)}><BlockText text={source.label} notebook={props.notebook} interactive={false} /></div>
        <Show when={source.hostname}><div class="table-source-host">{source.hostname}</div></Show>
      </div>}</Show>
      <Button class="table-source-count" label={`${props.field?.name ?? 'Sources'}: ${sources().length} ${sources().length === 1 ? 'ref' : 'refs'}`} aria-haspopup="dialog" onKeyDown={event => event.stopPropagation()} onDblClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); props.onSources(event.currentTarget, sources()); }}>{sources().length} {sources().length === 1 ? 'ref' : 'refs'}</Button>
    </div>
    <Show when={parsed().some(value => value.remainder)}><div class="table-source-remainder"><TableCellText>{expanded => <For each={parsed().filter(value => value.remainder)}>{(entry, index) => <>{index() > 0 ? ', ' : ''}<span classList={{ 'table-reading-problem': !entry.value.reading.ok }} title={!entry.value.reading.ok ? entry.value.reading.problem : undefined}><BlockText text={preview(entry.remainder, expanded)} notebook={props.notebook} interactive={false} /></span></>}</For>}</TableCellText></div></Show>
  </Show>;
}

function SourcesPopup(props: { anchor: HTMLElement; label: string; sources: TableSource[]; notebook: NotebookClient; onDismiss(): void }) {
  return <Popup anchor={props.anchor} label={`Sources · ${props.label}`} class="table-sources-popup" onDismiss={props.onDismiss} width={400}>
    <div onKeyDown={event => {
      event.stopPropagation();
      if (event.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>('a[href]'));
      const index = links.indexOf(document.activeElement as HTMLAnchorElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      links[next]?.focus(); event.preventDefault();
    }}>
      <div class="table-popup-heading"><span>{props.label}</span><span class="table-popup-count">{props.sources.length} {props.sources.length === 1 ? 'ref' : 'refs'}</span></div>
      <ol class="table-source-list"><For each={props.sources}>{source => <li><a class="table-source-link" href={source.href} target="_blank" rel="noopener noreferrer" tabIndex={0}>{plainText(source.label, props.notebook.lookup)} <span aria-hidden="true">↗</span></a><Show when={source.hostname}><span class="table-source-host">{source.hostname}</span></Show><span class="table-source-href">{source.href}</span></li>}</For></ol>
    </div>
  </Popup>;
}

/** Clamped cells measure in batches, all reads before any write, so mounting a table lays out once. */
interface CellMeasure { read(): boolean; write(clipped: boolean): void }
const cellMeasures = new WeakMap<Element, CellMeasure>();
const pendingCells = new Set<CellMeasure>();
let cellFrame = 0;
let cellResize: ResizeObserver | undefined;
function measureCells(cells: CellMeasure[]) {
  const clipped = cells.map(cell => cell.read());
  cells.forEach((cell, index) => cell.write(clipped[index]!));
}
function flushCells() { cellFrame = 0; const cells = [...pendingCells]; pendingCells.clear(); measureCells(cells); }
function observeCell(element: Element, measure: CellMeasure): { schedule(): void; dispose(): void } {
  // A newly observed element reports once after layout, which covers the first measurement.
  cellResize ??= new ResizeObserver(entries => measureCells(entries.flatMap(entry => cellMeasures.get(entry.target) ?? [])));
  cellMeasures.set(element, measure);
  cellResize.observe(element);
  return {
    schedule() { pendingCells.add(measure); cellFrame ||= requestAnimationFrame(flushCells); },
    dispose() { cellResize?.unobserve(element); cellMeasures.delete(element); pendingCells.delete(measure); },
  };
}

/** Clamped cells show three lines, so they shape only a prefix; long values otherwise dominate a large table's layout. */
const PREVIEW_CHARACTERS = 400;
function preview(text: string, expanded: boolean): string {
  if (expanded || text.length <= PREVIEW_CHARACTERS) return text;
  let end = 0;
  for (const token of textTokens(text)) {
    if (token.start >= PREVIEW_CHARACTERS) break;
    end = token.kind === 'text' ? Math.min(token.end, PREVIEW_CHARACTERS) : token.end;
  }
  return `${text.slice(0, end)}…`;
}

function TableCellText(props: { children: (expanded: boolean) => JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  const [clipped, setClipped] = createSignal(false);
  let content!: HTMLDivElement;
  onMount(() => {
    const cell = observeCell(content, { read: () => !open() && content.scrollHeight > content.clientHeight, write: value => { if (!open()) setClipped(value); } });
    const mutation = new MutationObserver(() => cell.schedule());
    mutation.observe(content, { subtree: true, childList: true, characterData: true });
    onCleanup(() => { cell.dispose(); mutation.disconnect(); });
  });
  return <>
    <div ref={content} class="table-cell-clamp" classList={{ 'table-cell-open': open() }}>{props.children(open())}</div>
    <Show when={clipped()}><Button class="table-cell-more" aria-expanded={open()} onMouseDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onDblClick={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); setOpen(value => !value); }}>{open() ? 'Less' : 'More'}</Button></Show>
  </>;
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
