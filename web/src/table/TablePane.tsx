import { For, Show, createEffect, createMemo, createResource, createRoot, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { ulid } from 'ulid';
import { api } from '../api/client';
import type { FieldDefinition, FieldKind, Fields, FieldValue, NoteIndex, Operation, Query, QueryResult, QueryRow, SortKey, Type, View } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { BlockText } from '../outline/BlockText';
import { plainText } from '../outline/names';
import type { OpenTarget, PaneId, TableViewState } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup } from '../ui/Popup';
import { TypeModeTabs } from '../ui/TypeModeTabs';
import { checkboxValue, kindLabels, partialDatePlaceholder } from '../fields/kinds';
import { ValueEditor, writeFieldValue } from '../fields/value-editor';
import { hasValueEditor } from '../fields/value-options';
import { noteKindIcon } from '../notes/kinds';
import { autoPlural } from '../fields/presentation';
import { FilterPopup } from './FilterPopup';
import { addFilter, chooseSort, copyQuery, fieldEntryId, fieldEntryText, filterLabel, queriesEqual, removeFilter, removeSort, sortLabel } from './query';
import { sourceText } from './sources';
import type { TableSource } from './sources';
import { cardFields, retainCell, rowSources, sourceDefinition, splitMembers } from './register';
import type { TableCell } from './register';
import './table.css';

type TableTarget = Extract<OpenTarget, { kind: 'table' }>;
interface TablePaneProps {
  pane: PaneId; target: TableTarget; view: TableViewState; notebook: NotebookClient; active: boolean;
  onActivate(): void; onOpen(target: OpenTarget, beside: boolean): void;
  onTargetChange(target: TableTarget): void; onViewChange(view: TableViewState): void;
}
type PopupState = { kind: 'menu'; anchor: HTMLElement; items: MenuItem[]; label: string; header?: JSX.Element }
  | { kind: 'filter'; anchor: HTMLElement; field: string }
  | { kind: 'name'; anchor: HTMLElement; action: 'save' | 'rename' | 'field'; addColumn?: boolean }
  | { kind: 'columns'; anchor: HTMLElement }
  | { kind: 'sources'; anchor: HTMLElement; label: string; sources: TableSource[] }
  | { kind: 'delete'; anchor: HTMLElement; view: View }
  | { kind: 'value'; anchor: HTMLElement; row: QueryRow; field: FieldDefinition; value?: FieldValue }
  | null;
const valuePlaceholders: Partial<Record<FieldKind, string>> = { date: partialDatePlaceholder, url: 'https://', identifier: 'ISBN, DOI or arXiv ID' };
const titleWidthLimits = { min: 170, max: 340, default: 240 };
const clampTitleWidth = (width: number | undefined) => Number.isFinite(width) ? Math.max(titleWidthLimits.min, Math.min(titleWidthLimits.max, width!)) : titleWidthLimits.default;
const refsColumn = '$refs';
const membersLabel = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'member' : 'members'}`;

export function TablePane(props: TablePaneProps) {
  const [query, setQuery] = createSignal(copyQuery(props.view.query));
  const [search, setSearch] = createSignal(query().text ?? '');
  const [hiddenFields, setHiddenFields] = createSignal([...(props.view.hiddenFields ?? [])]);
  const [titleWidth, setTitleWidth] = createSignal(clampTitleWidth(props.view.titleWidth));
  const [result, setResult] = createSignal<QueryResult>();
  const [definitions, setDefinitions] = createSignal<Fields>();
  const [type, setType] = createSignal<Type>();
  const [noteIndex, setNoteIndex] = createSignal<NoteIndex>();
  const [loading, setLoading] = createSignal(true);
  const [appending, setAppending] = createSignal(false);
  const pageSize = () => query().limit ?? 500;
  const canAppend = createMemo(() => pageSize() > 0 && !!result() && result()!.rows.length < result()!.total);
  let appendController: AbortController | undefined;
  const [error, setError] = createSignal('');
  const [popup, setPopup] = createSignal<PopupState>(null);
  const [focused, setFocused] = createSignal<TableCell>({ rowId: null, fieldId: null });
  const [selectedRow, setSelectedRow] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<{ row: QueryRow; field: FieldDefinition; text: string } | null>(null);
  const [deleted, setDeleted] = createSignal<View | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [savedRevision, setSavedRevision] = createSignal(0);
  let region!: HTMLDivElement; let scroll!: HTMLDivElement; let grid!: HTMLTableElement;
  const documents = new Map<string, PageDocument>();
  const history: { doc: PageDocument; rowId: string; fieldId: string }[] = [];
  const undone: typeof history = [];
  onCleanup(() => { for (const doc of documents.values()) doc.release(); });
  const focusCell = (rowId: string, fieldId: string | null) => {
    region?.querySelector<HTMLElement>(`tr[data-block-id="${rowId}"] ${fieldId ? `[data-field-id="${fieldId}"]` : '.table-title-column.table-cell'}`)?.focus({ preventScroll: true });
  };
  const showResult = (next: QueryResult) => {
    const cell = document.activeElement?.closest<HTMLElement>('.table-cell');
    const rowId = cell?.closest<HTMLElement>('tr')?.dataset.blockId;
    const fieldId = cell?.dataset.fieldId ?? null;
    const restore = !!cell && region.contains(cell);
    setResult(next);
    if (restore && rowId) focusCell(rowId, fieldId);
  };
  const refreshCells = async () => showResult(await api.query({ ...copyQuery(query()), offset: 0, limit: Math.max(pageSize(), result()?.rows.length ?? 0) }));
  // Columns past the right edge get a fade over the table rows and a count in the header, so a wide register says it scrolls.
  const [edge, setEdge] = createSignal({ height: 0, hidden: 0 });
  const measureEdge = () => {
    const view = scroll.getBoundingClientRect();
    const hidden = scroll.scrollLeft + scroll.clientWidth < grid.offsetWidth - 1
      ? [...grid.tHead?.rows[0]?.cells ?? []].filter(cell => cell.getBoundingClientRect().right > view.left + scroll.clientWidth + 1).length : 0;
    setEdge({ hidden, height: hidden ? Math.max(0, Math.min(scroll.clientHeight, grid.getBoundingClientRect().bottom - view.top)) : 0 });
  };
  const showMoreColumns = () => scroll.scrollBy({ left: scroll.clientWidth - titleWidth(), behavior: 'smooth' });
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
    if (change?.views?.length) setSavedRevision(change.seq);
  });
  const [saved, { refetch: refetchSaved, mutate: setSaved }] = createResource(
    () => ({ id: viewId(), revision: savedRevision() }),
    async ({ id }) => {
      if (!id) return undefined;
      try { return await api.view(id); }
      catch (reason) { message(reason); return undefined; }
    },
  );
  const [views, { refetch: refetchViews }] = createResource(savedRevision, async () => {
    try { return await api.views(); }
    catch (reason) { message(reason); return []; }
  });
  const fields = createMemo(() => {
    const combined = new Map<string, FieldDefinition>((definitions()?.fields ?? []).map(field => [field.id, field]));
    for (const field of result()?.fields ?? []) if (!combined.has(field.id)) combined.set(field.id, field);
    return [...combined.values()];
  });
  const fieldById = (id: string) => fields().find(field => field.id === id);
  const visibleColumns = createMemo(() => (result()?.columns ?? []).filter(id => !hiddenFields().includes(id)));
  const members = createMemo(() => splitMembers(result()?.rows ?? []));
  const sourceField = createMemo(() => sourceDefinition(result()?.columns ?? [], fields()));
  const showRefs = () => !!sourceField() && !hiddenFields().includes(refsColumn);
  const sourcesByRow = createMemo(() => new Map((result()?.rows ?? []).map(row => [row.block.block.id, rowSources(row, sourceField())])));
  const typeKind = () => noteIndex()?.kinds.find(kind => kind.type_id === query().type);
  const columnWidth = (id: string) => {
    const kind = fieldById(id)?.kind;
    return kind === 'text' || kind === 'url' ? 'var(--table-source-width)' : kind === 'number' || kind === 'checkbox' || kind === 'date' ? 'var(--table-compact-width)' : 'var(--table-field-width)';
  };
  createEffect(() => {
    setFocused(retainCell(untrack(focused), members().notes, visibleColumns()));
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
  const title = () => typeKind()?.plural ?? type()?.plural ?? autoPlural(type()?.page.text ?? props.notebook.lookup(query().type ?? '')()?.text ?? '');
  const updateQuery = (next: Query) => {
    setQuery(copyQuery(next));
    reportView(next);
  };
  createEffect(() => {
    const value = copyQuery(query()); props.notebook.changeSequence();
    const controller = new AbortController();
    appendController?.abort(); setAppending(false); setLoading(true);
    const timer = setTimeout(() => {
      void Promise.all([api.query({ ...value, offset: 0 }, controller.signal), api.fields(controller.signal), value.type ? api.type(value.type, controller.signal) : Promise.resolve(undefined), value.type ? api.noteIndex(controller.signal) : Promise.resolve(undefined)])
        .then(([rows, allFields, pageType, index]) => {
          if (controller.signal.aborted) return;
          showResult(rows); setDefinitions(allFields); setType(pageType); setNoteIndex(index); setError(''); setLoading(false);
          if (!restoredScroll) {
            restoredScroll = true;
            requestAnimationFrame(() => { if (scroll) { scroll.scrollTop = props.view.scroll; scroll.scrollLeft = props.view.horizontalScroll ?? 0; } });
          }
        }).catch(reason => { if (!controller.signal.aborted) { message(reason); setLoading(false); } });
    }, 150);
    onCleanup(() => { clearTimeout(timer); controller.abort(); appendController?.abort(); });
  });
  const appendRows = async () => {
    const current = result();
    if (!current || loading() || appending() || !canAppend()) return;
    const controller = new AbortController(); appendController = controller;
    setAppending(true); setError('');
    try {
      const next = await api.query({ ...copyQuery(query()), limit: pageSize(), offset: current.rows.length }, controller.signal);
      if (controller.signal.aborted) return;
      const top = scroll.scrollTop; const left = scroll.scrollLeft;
      const viewport = scroll.getBoundingClientRect();
      const anchor = [...scroll.querySelectorAll<HTMLElement>('[data-block-id]')].find(row => {
        const bounds = row.getBoundingClientRect();
        return bounds.width > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      const anchorTop = anchor?.getBoundingClientRect().top;
      setResult({ ...next, rows: [...current.rows, ...next.rows] });
      requestAnimationFrame(() => {
        if (controller.signal.aborted) return;
        scroll.scrollTop = top + (anchor && anchorTop !== undefined ? anchor.getBoundingClientRect().top - anchorTop : 0);
        scroll.scrollLeft = left;
        reportView(); measureEdge();
      });
    } catch (reason) {
      if (!controller.signal.aborted) message(reason);
    } finally {
      if (!controller.signal.aborted) setAppending(false);
    }
  };
  onCleanup(() => { clearTimeout(searchTimer); clearTimeout(deletedTimer); });
  const submit = async (operation: Operation) => {
    await api.submit({ actor: { kind: 'client', name: 'tessera-web-table' }, idempotency_key: ulid(), operations: [operation] });
  };
  const withDocument = async (pageId: string, action: (doc: PageDocument) => void | Promise<void>) => {
    let doc = documents.get(pageId);
    if (!doc) { doc = props.notebook.open(pageId); documents.set(pageId, doc); }
    const current = doc;
    const ready = Promise.withResolvers<void>();
    createRoot(dispose => {
      createEffect(() => {
        const status = current.status();
        if (status === 'ready') { dispose(); ready.resolve(); }
        else if (status !== 'loading') { dispose(); ready.reject(new Error(current.statusMessage())); }
      });
    });
    await ready.promise;
    await action(current);
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
    await refetchViews();
    props.onTargetChange({ kind: 'table', typeId: query().type, viewId: id, query: copyQuery(query()) });
    setPopup(null);
  };
  const saveChanges = async () => {
    const value = saved(); if (!value) return;
    await submit({ op: 'save_view', id: value.id, base_revision: value.revision, name: value.name, query: copyQuery(query()) });
    await refetchSaved();
    await refetchViews();
  };
  const deleteView = async (value: View) => {
    if (deleting()) return;
    setDeleting(true); setError('');
    try {
      await submit({ op: 'delete_view', id: value.id, base_revision: value.revision });
      setDeleted(value); setSaved(undefined);
      await refetchViews();
      props.onTargetChange({ kind: 'table', typeId: query().type, viewId: null, query: copyQuery(query()) });
      clearTimeout(deletedTimer); deletedTimer = setTimeout(() => setDeleted(null), 10000);
      setPopup(null);
    } catch (reason) { message(reason); }
    finally { setDeleting(false); }
  };
  const undoDelete = async () => {
    const value = deleted(); if (!value) return;
    await submit({ op: 'save_view', id: value.id, base_revision: null, name: value.name, query: value.query });
    setDeleted(null); props.onTargetChange({ kind: 'table', typeId: query().type, viewId: value.id, query: copyQuery(query()) });
    await refetchSaved();
    await refetchViews();
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
  const switchView = (view: View | null) => {
    const next = view?.query ?? { type: query().type, text: null, filters: [], sort: [], limit: null };
    clearTimeout(searchTimer); setSearch(next.text ?? ''); updateQuery(next); setSaved(view ?? undefined);
    setSelectedRow(null); setFocused({ rowId: null, fieldId: null }); setPopup(null);
    props.onTargetChange({ kind: 'table', typeId: next.type, viewId: view?.id ?? null, query: copyQuery(next) });
    if (scroll) { scroll.scrollTop = 0; scroll.scrollLeft = 0; }
    reportView(next);
  };
  const viewMenu = (anchor: HTMLElement) => setPopup({ kind: 'menu', anchor, label: 'Views',
    header: <><div class="table-popup-heading">Views</div><div class="table-popup-note">{title() || 'All blocks'} · {query().filters.length ? `${query().filters.length} filters` : 'No filters'}<Show when={query().sort.length}> · {query().sort.map(key => sortLabel(key, fields())).join(', ')}</Show></div></>,
    items: [
      { label: title() ? `All ${title()}` : 'All blocks', checked: !props.target.viewId, action: () => switchView(null) },
      ...(views() ?? []).filter(view => view.query.type === query().type).map((view): MenuItem => ({ label: view.name, checked: view.id === props.target.viewId, action: () => switchView(view) })),
      { label: 'Save as view…', section: 'View actions', action: () => setPopup({ kind: 'name', anchor, action: 'save' }) },
      ...(props.target.viewId ? [
        ...(changed() ? [{ label: 'Save', action: () => { void saveChanges().catch(message); } }, { label: 'Discard changes', action: () => { const value = saved(); if (value) switchView(value); } }] : []),
        { label: 'Rename view…', disabledReason: !saved() ? 'Loading…' : undefined, action: () => setPopup({ kind: 'name', anchor, action: 'rename' }) },
        { label: props.notebook.confirmViewDelete() ? 'Delete view…' : 'Delete view', icon: 'trash' as const, danger: true, disabledReason: !saved() ? 'Loading…' : undefined, action: () => { const view = saved(); if (view) { setError(''); if (props.notebook.confirmViewDelete()) setPopup({ kind: 'delete', anchor, view }); else void deleteView(view); } } },
      ] : []),
    ],
  });
  const showFilter = (anchor: HTMLElement, field = '') => {
    const initial = field || (window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches ? visibleColumns().find(id => fieldById(id)?.kind === 'choice') ?? '' : '');
    setPopup({ kind: 'filter', anchor, field: initial });
  };
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
  const openRow = (row: QueryRow, beside: boolean) => {
    setSelectedRow(row.block.block.id);
    props.onOpen({ kind: 'page', pageId: row.block.page.id, ...(row.block.block.kind === 'block' ? { blockId: row.block.block.id } : {}) }, beside || window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches);
  };
  const openField = (row: QueryRow, field: FieldDefinition) => {
    void withDocument(row.block.page.id, doc => {
      const owner = row.block.block;
      const entries = doc.outline.children(owner.id).filter(id => fieldEntryId(doc.block(id)?.text ?? '') === field.id && !doc.block(id)?.archived);
      props.onOpen({ kind: 'page', pageId: owner.page_id, blockId: entries.length === 1 ? entries[0] : owner.kind === 'block' ? owner.id : undefined }, true);
    }).catch(message);
  };
  const openPill = async (row: QueryRow, field: FieldDefinition, value: FieldValue, anchor: HTMLElement, beside: boolean) => {
    if (field.kind === 'choice' && !beside) {
      anchor.closest<HTMLElement>('.table-cell')?.focus({ preventScroll: true });
      setPopup({ kind: 'value', row, field, value, anchor }); return;
    }
    const id = fieldEntryId(value.text);
    if (!id) return;
    const target = props.notebook.lookup(id)() ?? await props.notebook.api.block(id);
    props.onOpen({ kind: 'page', pageId: target.page_id, ...(target.kind === 'block' ? { blockId: target.id } : {}) }, beside || window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches);
  };
  const writeCell = async (row: QueryRow, field: FieldDefinition, text: string, value = row.values[field.id]?.[0]) => {
    await withDocument(row.block.page.id, async doc => {
      if ((value?.text ?? '') === text) return;
      writeFieldValue(doc, { field, ownerId: row.block.block.id, valueId: value?.id }, text);
      history.push({ doc, rowId: row.block.block.id, fieldId: field.id }); undone.length = 0;
      await doc.flush();
      await refreshCells();
    });
  };
  const startEdit = (row: QueryRow, field: FieldDefinition, anchor: HTMLElement) => {
    const values = row.values[field.id] ?? [];
    if (values.length > 1) { openField(row, field); return; }
    if (field.kind === 'checkbox') { void writeCell(row, field, checkboxValue(values[0]?.text ?? '') ? 'no' : 'yes').catch(message); return; }
    if (hasValueEditor(field, values[0]?.text ?? '', props.notebook.todayDate())) {
      setPopup({ kind: 'value', row, field, anchor }); return;
    }
    if (values.some(value => textTokens(value.text).some(token => token.kind === 'reference' || token.kind === 'tag'))) { openField(row, field); return; }
    setEditing({ row, field, text: values[0]?.text ?? '' });
  };
  const commitEdit = async () => {
    const current = editing(); if (!current) return;
    setEditing(null);
    const original = current.row.values[current.field.id]?.[0]?.text ?? '';
    if (current.text !== original) {
      try { await writeCell(current.row, current.field, current.text); }
      catch (reason) { message(reason); }
    }
    requestAnimationFrame(() => focusCell(current.row.block.block.id, current.field.id));
  };
  const replayCell = async (redo: boolean) => {
    const source = redo ? undone : history;
    const entry = source.pop(); if (!entry) return;
    redo ? entry.doc.redo() : entry.doc.undo();
    (redo ? history : undone).push(entry);
    await entry.doc.flush();
    await refreshCells();
    focusCell(entry.rowId, entry.fieldId);
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable="true"]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.stopPropagation(); void replayCell(event.shiftKey).catch(message); return;
    }
    if (event.target instanceof HTMLElement && event.target.closest('button, a')) return;
    const current = focused(); const rows = members().notes; const columns = visibleColumns();
    const rowIndex = Math.max(0, rows.findIndex(row => row.block.block.id === current.rowId));
    const columnIndex = current.fieldId ? columns.indexOf(current.fieldId) + 1 : 0;
    const row = rows[rowIndex];
    if (event.key === 'Escape') { region.focus(); event.preventDefault(); return; }
    const field = current.fieldId ? fieldById(current.fieldId) : undefined;
    if ((event.key === 'Enter' || event.key === ' ' && field?.kind === 'checkbox') && row) {
      if (!current.fieldId) openRow(row, event.shiftKey);
      else if (field && event.target instanceof HTMLElement) startEdit(row, field, event.target);
      event.preventDefault(); return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const nextRow = rows[Math.max(0, Math.min(rows.length - 1, rowIndex + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)))];
    const nextColumn = Math.max(0, Math.min(columns.length, columnIndex + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0)));
    if (nextRow) {
      const next = { rowId: nextRow.block.block.id, fieldId: columns[nextColumn - 1] ?? null };
      setFocused(next); focusCell(next.rowId, next.fieldId);
    }
    event.preventDefault();
  };
  onMount(() => {
    if (props.active) region.focus({ preventScroll: true });
    const resize = new ResizeObserver(measureEdge);
    resize.observe(scroll); resize.observe(grid);
    onCleanup(() => resize.disconnect());
  });
  return <div ref={region} class="table-pane" style={{ '--table-title-width': `${titleWidth()}px`, '--table-width': `calc(${titleWidth()}px + ${visibleColumns().map(columnWidth).join(' + ') || '0px'} + ${showRefs() ? 'var(--table-refs-width)' : '0px'})` }} tabIndex={0} role="region" aria-label="Table" onFocusIn={props.onActivate} onPointerDown={props.onActivate} onKeyDown={keydown}>
    <div class="table-register">
      <header class="table-header">
        <div class="table-heading">
          <div class="table-register-label"><Show when={query().type}><Button class="table-type-label" onClick={event => props.onOpen({ kind: 'page', pageId: query().type! }, event.shiftKey)}>{title()}</Button><span aria-hidden="true"> / </span></Show><span>Register</span></div>
          <h1><Button class="table-title" label="Views" aria-haspopup="menu" onClick={event => viewMenu(event.currentTarget)}><Show when={typeKind()}>{kind => <Icon name={noteKindIcon(kind())} />}</Show><span>{saved()?.name ?? (title() || 'All blocks')}</span><Icon name="down" /></Button></h1>
        </div>
        <div class="table-view-status"><Show when={props.target.viewId && saved()} fallback={<Show when={result()}>{rows => <>{membersLabel(rows().total)}</>}</Show>}>
          <span>{changed() ? 'Unsaved changes' : 'Saved view'}</span><Show when={changed()}><Button onClick={() => { void saveChanges().catch(message); }}>Save</Button><Button onClick={() => { const value = saved(); if (value) switchView(value); }}>Discard</Button></Show>
        </Show></div>
      </header>
      <Show when={query().type}>{typeId => <TypeModeTabs active="table" indexCount={typeKind()?.count ?? 0} tableCount={type()?.members ?? 0} fieldsCount={type()?.fields.length ?? 0}
        cardsCount={type()?.card_templates ?? 0} onCards={event => props.onOpen({ kind: 'cards', typeId: typeId() }, event.shiftKey)}
        onIndex={event => props.onOpen({ kind: 'index', key: typeKind()?.key ?? `type:${typeId()}` }, event.shiftKey)}
        onTable={event => props.onOpen({ kind: 'table', typeId: typeId(), viewId: props.target.viewId, query: copyQuery(query()) }, event.shiftKey)}
        onFields={event => props.onOpen({ kind: 'fields', typeId: typeId() }, event.shiftKey)} />}</Show>
      <div class="table-toolbar">
        <input class="input table-search" placeholder="Search rows…" aria-label="Search rows" value={search()} onInput={event => {
          const text = event.currentTarget.value; setSearch(text); clearTimeout(searchTimer);
          searchTimer = setTimeout(() => updateQuery({ ...query(), text: text.trim() ? text : null }), 150);
        }} />
        <div class="table-query-controls">
          <Button class="bordered table-filter-button" aria-haspopup="dialog" onClick={event => showFilter(event.currentTarget)}>Filters<Show when={query().filters.length}><span class="table-control-count">{query().filters.length}</span></Show></Button>
          <Button class="bordered" aria-haspopup="menu" onClick={event => sortMenu(event.currentTarget)}>Sort <Icon name="down" /></Button>
          <Button class="bordered table-columns-button" aria-haspopup="dialog" aria-expanded={popup()?.kind === 'columns'} onClick={event => setPopup(popup()?.kind === 'columns' ? null : { kind: 'columns', anchor: event.currentTarget })}>Columns <Icon name="down" /></Button>
        </div>
      </div>
      <Show when={query().sort.length || query().filters.length}><div class="table-query-chips">
        <For each={query().sort}>{(key, index) => <span class="table-chip">{sortLabel(key, fields())}<Button label={`Remove ${sortLabel(key, fields())}`} onClick={() => updateQuery(removeSort(query(), index()))}>×</Button></span>}</For>
        <For each={query().filters}>{(filter, index) => <span class="table-chip">{filterLabel(filter, fields())}<Button label={`Remove ${filterLabel(filter, fields())}`} onClick={() => updateQuery(removeFilter(query(), index()))}>×</Button></span>}</For>
      </div></Show>
      <div class="table-scroll-frame">
      <div ref={scroll} class="table-scroll" onScroll={() => { cancelAnimationFrame(scrollReport); scrollReport = requestAnimationFrame(() => { reportView(); measureEdge(); }); }}>
        <table ref={grid} class="type-table table-grid" role="grid"><colgroup><col style={{ width: 'var(--table-title-width)' }} /><For each={visibleColumns()}>{id => <col style={{ width: columnWidth(id) }} />}</For><Show when={showRefs()}><col style={{ width: 'var(--table-refs-width)' }} /></Show></colgroup>
          <thead><tr><th scope="col" class="table-title-column"><Button aria-haspopup="menu" onClick={event => columnMenu(event.currentTarget, undefined)}>Title</Button></th>
          <For each={visibleColumns()}>{id => <th scope="col"><Button aria-haspopup="menu" onClick={event => columnMenu(event.currentTarget, fieldById(id))}>{fieldById(id)?.name ?? id}</Button></th>}</For>
          <Show when={showRefs()}><th scope="col" class="table-refs" title={`Derived from ${sourceField()?.name ?? 'Source'}`}>Refs</th></Show>
        </tr></thead><tbody><For each={members().notes}>{row => <tr data-block-id={row.block.block.id} classList={{ selected: selectedRow() === row.block.block.id }} onClick={event => {
          if (window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches && !(event.target as HTMLElement).closest('button, input, textarea, a')) openRow(row, true);
        }}>
          <td class="table-title-column table-cell" tabIndex={focused().rowId === row.block.block.id && focused().fieldId === null ? 0 : -1} onFocus={() => { setFocused({ rowId: row.block.block.id, fieldId: null }); setSelectedRow(row.block.block.id); }} onClick={event => { event.stopPropagation(); openRow(row, event.shiftKey); }}>
            <TableCellText>{expanded => <BlockText text={preview(props.notebook.lookup(row.block.block.id)()?.text ?? row.block.block.text, expanded)} notebook={props.notebook} interactive={false} />}</TableCellText>
            <Button class="table-row-beside" label="Open note beside" onClick={event => { event.stopPropagation(); openRow(row, true); }}>↗</Button>
          </td>
          <For each={visibleColumns()}>{id => {
            const field = () => fieldById(id); const current = () => editing();
            return <td class={`table-cell table-kind-${field()?.kind ?? 'text'}`} data-field-id={id} tabIndex={focused().rowId === row.block.block.id && focused().fieldId === id ? 0 : -1} onFocus={() => { setFocused({ rowId: row.block.block.id, fieldId: id }); setSelectedRow(row.block.block.id); }} onClick={event => { event.stopPropagation(); if ((event.target as HTMLElement).closest('input, textarea, button, a')) return; event.currentTarget.focus({ preventScroll: true }); if (field()?.kind === 'checkbox') startEdit(row, field()!, event.currentTarget); }} onDblClick={event => { event.stopPropagation(); if (!(event.target as HTMLElement).closest('input, textarea') && field() && field()!.kind !== 'checkbox') startEdit(row, field()!, event.currentTarget); }}>
              <Show when={current()?.row.block.block.id === row.block.block.id && current()?.field.id === id} fallback={<TableFieldValue field={field()} values={row.values[id] ?? []} notebook={props.notebook} hideCount={id === sourceField()?.id} onPill={(value, anchor, beside) => { if (field()) void openPill(row, field()!, value, anchor, beside).catch(message); }} onSources={(anchor, sources) => setPopup({ kind: 'sources', anchor, label: field()?.name ?? 'Sources', sources })} />}>
                <textarea class="input table-cell-input" aria-label={`Edit ${field()?.name ?? 'field'} value`} placeholder={field() ? valuePlaceholders[field()!.kind] : undefined} inputmode={field()?.kind === 'number' ? 'decimal' : field()?.kind === 'url' ? 'url' : undefined} rows={Math.min(8, Math.max(1, (current()?.text.match(/\n/g)?.length ?? 0) + 1))} value={current()?.text ?? ''} ref={input => queueMicrotask(() => { input.focus(); input.select(); })} onInput={event => { const text = event.currentTarget.value; setEditing(value => value ? { ...value, text } : null); }} onKeyDown={event => {
                  if (event.isComposing) return;
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void commitEdit(); }
                  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); region.focus(); }
                }} onBlur={() => { void commitEdit(); }} />
              </Show>
            </td>;
          }}</For><Show when={showRefs()}><td class="table-refs"><Show when={(sourcesByRow().get(row.block.block.id) ?? []).length}>{count => <Button class="table-source-count" label={`${count()} ${count() === 1 ? 'reference' : 'references'}`} aria-haspopup="dialog" onClick={event => { event.stopPropagation(); setPopup({ kind: 'sources', anchor: event.currentTarget, label: sourceField()?.name ?? 'Source', sources: sourcesByRow().get(row.block.block.id) ?? [] }); }}>{count()}</Button>}</Show></td></Show>
        </tr>}</For></tbody></table>
        <div class="table-cards" role="list" aria-label="Notes"><For each={members().notes}>{row => <article class="table-card" data-block-id={row.block.block.id} classList={{ selected: selectedRow() === row.block.block.id }} role="listitem" onClick={event => {
          if (!(event.target as HTMLElement).closest('button, [role="button"], a')) openRow(row, event.shiftKey);
        }}>
          <Button class="table-card-title" onClick={event => openRow(row, event.shiftKey)}><BlockText text={props.notebook.lookup(row.block.block.id)()?.text ?? row.block.block.text} notebook={props.notebook} interactive={false} /><span class="table-card-arrow" aria-hidden="true">›</span></Button>
          <div class="table-card-fields"><For each={cardFields(row, visibleColumns(), fields(), sourceField())}>{field => <div class={`table-card-field table-kind-${field.kind}`} classList={{ 'table-card-source': field.id === sourceField()?.id }} role="button" tabIndex={0} aria-label={`Open ${field.name} field`} onClick={event => { event.stopPropagation(); if (!(event.target as HTMLElement).closest('button')) openField(row, field); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); openField(row, field); } }}>
            <TableFieldValue field={field} values={row.values[field.id] ?? []} notebook={props.notebook} hideCount onPill={(value, anchor, beside) => { void openPill(row, field, value, anchor, beside).catch(message); }} onSources={(anchor, sources) => setPopup({ kind: 'sources', anchor, label: field.name, sources })} />
          </div>}</For><Show when={showRefs() && (sourcesByRow().get(row.block.block.id) ?? []).length}>{count => <Button class="table-source-count table-card-refs" label={`${count()} references`} aria-haspopup="dialog" onClick={event => { event.stopPropagation(); setPopup({ kind: 'sources', anchor: event.currentTarget, label: sourceField()?.name ?? 'Source', sources: sourcesByRow().get(row.block.block.id) ?? [] }); }}>{count()} {count() === 1 ? 'ref' : 'refs'}</Button>}</Show></div>
        </article>}</For></div>
        <Show when={!loading() && !error() && !members().notes.length}><p class="table-empty">No note members.</p></Show>
        <Show when={members().blocks.length}><section class="table-tagged-blocks" aria-label="Tagged blocks">
          <h2>Tagged blocks <span class="table-popup-count">{members().blocks.length}</span></h2>
          <For each={members().blocks}>{row => <div class="table-block-member" data-block-id={row.block.block.id}>
            <div><div class="table-block-text"><BlockText text={preview(props.notebook.lookup(row.block.block.id)()?.text ?? row.block.block.text, false)} notebook={props.notebook} interactive={false} /></div><div class="table-page-title">Block in {row.block.page.text}</div></div>
            <Button class="bordered" onClick={event => openRow(row, event.shiftKey)}>Open ↗</Button>
          </div>}</For>
        </section></Show>
      </div>
      <Show when={edge().hidden}><div class="table-more-right" style={{ height: `${edge().height}px` }}><Button class="table-more-columns" label={`Scroll to ${edge().hidden} more ${edge().hidden === 1 ? 'column' : 'columns'}`} onClick={showMoreColumns}>+{edge().hidden} <Icon name="right" /></Button></div></Show>
      </div>
      <footer class="table-footer" role="status"><Show when={deleted()} fallback={<>
        <span>{loading() ? 'Loading…' : error() || `${(result()?.rows.length ?? 0).toLocaleString()} of ${membersLabel(result()?.total ?? 0)}`}</span>
        <Show when={!loading() && canAppend()}><span aria-hidden="true">·</span><Button class="table-show-more" disabled={appending()} aria-busy={appending()} onClick={() => { void appendRows(); }}>Show {pageSize().toLocaleString()} more</Button></Show>
      </>}>View deleted · <Button onClick={() => { void undoDelete().catch(message); }}>Undo</Button></Show></footer>
    </div>
    <Show keyed when={popup()}>{state => <>
      {state.kind === 'menu' && <Menu anchor={state.anchor} label={state.label} header={state.header} items={state.items} onDismiss={() => setPopup(null)} />}
      {state.kind === 'value' && <ValueEditor anchor={state.anchor} field={fieldById(state.field.id) ?? state.field} text={(state.value ?? state.row.values[state.field.id]?.[0])?.text ?? ''} notebook={props.notebook} contextDate={props.notebook.todayDate()}
        onWrite={text => writeCell(state.row, state.field, text, state.value)} onError={message} onDismiss={() => { setPopup(null); requestAnimationFrame(() => focusCell(state.row.block.block.id, state.field.id)); }} />}
      {state.kind === 'filter' && <FilterPopup anchor={state.anchor} fields={fields()} initialField={state.field} sheet={window.matchMedia('(max-width: 599px) and (pointer: coarse)').matches} onDismiss={() => setPopup(null)} onNewField={async name => createField(name, false)} onAdd={filter => { updateQuery(addFilter(query(), filter)); setPopup(null); }} />}
      {state.kind === 'name' && <NamePopup anchor={state.anchor} action={state.action} name={state.action === 'rename' ? saved()?.name ?? '' : ''} onDismiss={() => setPopup(null)} onSave={async name => { if (state.action === 'field') await createField(name, !!state.addColumn); else await saveView(name, state.action === 'rename'); }} />}
      {state.kind === 'delete' && <Popup anchor={state.anchor} label="Delete table view?" onDismiss={() => { if (!deleting()) setPopup(null); }}>
        <p>Delete “{state.view.name}”? Rows are not deleted.</p>
        <Show when={error()}><p class="error" role="alert">{error()}</p></Show>
        <div class="popup-actions"><Button disabled={deleting()} onClick={() => setPopup(null)}>Cancel</Button><Button class="bordered danger" disabled={deleting()} onClick={() => void deleteView(state.view)}>Delete view</Button></div>
      </Popup>}
      {state.kind === 'columns' && <Popup anchor={state.anchor} label="Columns" class="table-columns-popup" onDismiss={() => setPopup(null)} width={280}>
        <div class="table-popup-heading">Columns</div><div class="table-popup-note">Visibility in this register</div>
        <div class="table-column-choice table-column-fixed"><Icon name="check" />Title<span class="table-column-fixed-note">Always visible</span></div>
        <For each={result()?.columns ?? []}>{id => <label class="table-column-choice"><input type="checkbox" checked={!hiddenFields().includes(id)} onChange={event => showField(id, event.currentTarget.checked)} />{fieldById(id)?.name ?? id}</label>}</For>
        <Show when={sourceField()}>{field => <label class="table-column-choice"><input type="checkbox" checked={showRefs()} onChange={event => showField(refsColumn, event.currentTarget.checked)} />Refs<span class="table-column-fixed-note">From {field().name}</span></label>}</Show>
        <label class="table-width-control" for={`table-title-width-${props.pane}`}><span>Title width <output>{titleWidth()} px</output></span><input id={`table-title-width-${props.pane}`} type="range" min={titleWidthLimits.min} max={titleWidthLimits.max} value={titleWidth()} onInput={event => { setTitleWidth(clampTitleWidth(event.currentTarget.valueAsNumber)); reportView(); }} /></label>
        <div class="table-template-actions"><Button disabled={!query().type} title={!query().type ? 'Open a type to add fields' : undefined} onClick={() => addColumnMenu(state.anchor)}>Add field to type template…</Button><Button disabled={!query().type} onClick={event => props.onOpen({ kind: 'page', pageId: query().type! }, event.shiftKey)}>Open type template</Button></div>
      </Popup>}
      {state.kind === 'sources' && <SourcesPopup anchor={state.anchor} label={state.label} sources={state.sources} notebook={props.notebook} onDismiss={() => setPopup(null)} />}
    </>}</Show>
  </div>;
}

function TableFieldValue(props: { field: FieldDefinition | undefined; values: FieldValue[]; notebook: NotebookClient; hideCount?: boolean; onPill(value: FieldValue, anchor: HTMLElement, beside: boolean): void; onSources(anchor: HTMLElement, sources: TableSource[]): void }) {
  const parsed = createMemo(() => props.field?.kind === 'url' || props.field?.kind === 'text' ? props.values.map(value => ({ value, ...sourceText(value.text) })) : []);
  const sources = createMemo(() => parsed().flatMap(value => value.sources));
  const problems = createMemo(() => props.values.flatMap(value => value.reading.ok ? [] : [value.reading.problem]).join('; '));
  return <Show when={sources().length} fallback={<TableCellText>{expanded => <For each={props.values}>{(value, index) => <>
    {index() > 0 ? ', ' : ''}<Show when={value.reading.ok} fallback={<span class="table-reading-problem" title={!value.reading.ok ? value.reading.problem : undefined}><BlockText text={props.field?.kind === 'instance' ? value.text : preview(value.text, expanded)} blockId={value.id} notebook={props.notebook} interactive={false} /></span>}>
      <Show when={(props.field?.kind === 'choice' || props.field?.kind === 'instance') && fieldEntryId(value.text)} fallback={<span><BlockText text={value.reading.ok ? props.field?.kind === 'text' ? preview(value.text, expanded) : props.field?.kind === 'checkbox' ? value.reading.value ? '☑' : '☐' : String(value.reading.value) : ''} blockId={value.id} notebook={props.notebook} interactive={false} /></span>}>
        <Button class="table-value-pill" onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }} onDblClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); props.onPill(value, event.currentTarget, event.shiftKey); }}><BlockText text={props.field?.kind === 'instance' ? value.text : value.reading.ok ? String(value.reading.value) : value.text} blockId={value.id} notebook={props.notebook} interactive={false} /></Button>
      </Show>
    </Show>
  </>}</For>}</TableCellText>}>
    <div class="table-source-cell">
      <Show keyed when={sources()[0]}>{source => <div class="table-source-summary">
        <div class="table-source-label" classList={{ 'table-reading-problem': !!problems() }} title={problems() || plainText(source.label, id => props.notebook.lookup(id))}><BlockText text={source.label} notebook={props.notebook} interactive={false} /></div>
        <Show when={source.hostname}><div class="table-source-host">{source.hostname}</div></Show>
      </div>}</Show>
      <Show when={!props.hideCount}><Button class="table-source-count" label={`${props.field?.name ?? 'Sources'}: ${sources().length} ${sources().length === 1 ? 'ref' : 'refs'}`} aria-haspopup="dialog" onKeyDown={event => event.stopPropagation()} onDblClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); props.onSources(event.currentTarget, sources()); }}>{sources().length} {sources().length === 1 ? 'ref' : 'refs'}</Button></Show>
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
      <ol class="table-source-list"><For each={props.sources}>{source => <li><a class="table-source-link" href={source.href} target="_blank" rel="noopener noreferrer" tabIndex={0}>{plainText(source.label, id => props.notebook.lookup(id))} <span aria-hidden="true">↗</span></a><Show when={source.hostname}><span class="table-source-host">{source.hostname}</span></Show><span class="table-source-href">{source.href}</span></li>}</For></ol>
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
