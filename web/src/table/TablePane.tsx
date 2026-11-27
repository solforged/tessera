import { opensBeside, listOpensBeside } from '../core/beside';
import { glide } from '../ui/pane-motion';
import { Show, createEffect, createMemo, createRoot, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { ulid } from 'ulid';
import type { FieldDefinition, FieldValue, Operation, Query, QueryRow, SortKey, View } from '../api/types';
import type { WorkshopClient, PageDocument, RelationPickIntent } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { titleKey } from '../document/title-key';
import { BlockText } from '../outline/BlockText';
import { plainText } from '../outline/names';
import { EmbedOnPagePicker } from '../outline/ViewPicker';
import type { OpenTarget, PaneId, TableViewState } from '../core/contract';
import { pendingCaretInput } from '../ui/pending-caret';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { Popup, type PopupAnchor } from '../ui/Popup';
import { NavButton, NavEnd } from '../ui/NavBar';
import { openContextMenu } from '../ui/context-menu';
import { coarseQuery, isPhone, matchesCoarsePointer } from '../ui/viewport';
import { TypeModeTabs } from '../ui/TypeModeTabs';
import { checkboxValue, fieldLabel } from '../fields/kinds';
import { PlainValueInput, ValueEditor, writeFieldValue } from '../fields/value-editor';
import { hasValueEditor } from '../fields/value-options';
import { createOptionValue } from '../fields/commands';
import { requiredReason } from '../fields/required';
import { RequiredGaps } from '../fields/RequiredGaps';
import { noteKindIcon } from '../notes/kinds';
import { kindNoun } from '../create/kinds';
import type { CreateOptions, CreateRequest } from '../create/request';
import { FilterPopup } from './FilterPopup';
import { fieldEntryId } from '../core/field-entry';
import {
  addFilter,
  chooseSort,
  copyQuery,
  filterLabel,
  noteTableQuery,
  queriesEqual,
  removeQueryField,
  removeSort,
  retainFieldNames,
  typeQuery,
  untouchedQuery,
} from './query';
import { MissingFields } from './MissingFields';
import type { TableSource } from './sources';
import { cellScrollLeft, retainCell } from './register';
import type { TableCell } from './register';
import { querySources } from './attributes';
import { TableGrid } from './TableGrid';
import { ViewBody } from './ViewBody';
import { DeskPane } from '../desk/DeskPane';
import { createSavedViewController, DeleteSavedViewPopup, SavedViewNamePopup } from '../workflows/saved-views';
import { clampTitleWidth, createColumnResize } from './createColumnResize';
import { createTableQueryState } from './createTableQueryState';
import {
  phoneFieldsForRow,
  TableCardCell,
  TableColumnsPopup,
  TablePhoneFind,
  TablePhoneHead,
  TablePhoneOptions,
  TableQueryChips,
  TableQuerySheet,
  TableQueryToolbar,
  TableRefsButton,
} from './TableCardsView';
import { preview, SourcesPopup, TableAttributeValue, TableCellText, TableFieldValue } from './TableCellRenderers';
import '../ui/chips.css';
import './table.css';
import '../fields/fields.css';
import { TaskFieldEditor } from '../tasks/TaskFieldEditor';
import { taskFieldName } from '../tasks/task-fields';

type TableTarget = Extract<OpenTarget, { kind: 'table' }>;
export interface TablePaneProps {
  pane: PaneId;
  target: TableTarget;
  view: TableViewState;
  workshop: WorkshopClient;
  active: boolean;
  neighbour?: boolean;
  onActivate(): void;
  onCreate(request: CreateRequest, anchor?: PopupAnchor, options?: CreateOptions): void;
  onOpen(target: OpenTarget, beside: boolean): void;
  onTargetChange(target: TableTarget): void;
  onViewChange(view: TableViewState): void;
  onDeletePages?(pages: { id: string; title: string }[]): Promise<void>;
}
type PopupState =
  | {
      kind: 'menu';
      anchor: HTMLElement;
      items: MenuItem[];
      label: string;
      title?: string;
      context?: JSX.Element;
      header?: JSX.Element;
    }
  | { kind: 'filter'; anchor: HTMLElement; field: string }
  | { kind: 'name'; anchor: HTMLElement; action: 'save' | 'rename' | 'field'; addColumn?: boolean }
  | { kind: 'columns'; anchor: HTMLElement; cards?: boolean }
  | { kind: 'purpose'; anchor: HTMLElement }
  | { kind: 'sources'; anchor: HTMLElement; label: string; sources: TableSource[] }
  | { kind: 'delete'; anchor: HTMLElement; view: View }
  | { kind: 'delete-row'; anchor: HTMLElement; row: QueryRow }
  | { kind: 'embed-page'; anchor: HTMLElement; view: View }
  | { kind: 'value'; anchor: HTMLElement; row: QueryRow; field: FieldDefinition; value?: FieldValue }
  | { kind: 'task-field'; anchor: HTMLElement; row: QueryRow; field: FieldDefinition; doc: PageDocument }
  | null;
type TableEdit =
  | { kind: 'cell'; doc: PageDocument; rowId: string | null; fieldId: string | null }
  | { kind: 'created-row'; pageId: string }
  | { kind: 'view'; before: View; after: View; revision: number };
export function TablePane(props: TablePaneProps) {
  return (
    <Show when={props.view.query.layout === 'desk'} fallback={<TableContent {...props} />}>
      <DeskPane {...props} />
    </Show>
  );
}

function TableContent(props: TablePaneProps) {
  const [error, setError] = createSignal('');
  const [popup, setPopup] = createSignal<PopupState>(null);
  const [narrow, setNarrow] = createSignal(false);
  const phone = isPhone;
  const [querySheet, setQuerySheet] = createSignal<HTMLElement | null>(null);
  const [dockBounds, setDockBounds] = createSignal({ left: 0, width: 0 });
  const [focused, setFocused] = createSignal<TableCell>({ rowId: null, fieldId: null });
  const [selectedRow, setSelectedRow] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<{
    row: QueryRow;
    field: FieldDefinition;
    text: string;
    height?: number;
  } | null>(null);
  const [renaming, setRenaming] = createSignal<{ row: QueryRow; text: string } | null>(null);
  const [rowNotice, setRowNotice] = createSignal<{ id: string; title: string }>();
  const [rowUndo, setRowUndo] = createSignal(false);
  const [deletingRow, setDeletingRow] = createSignal(false);
  const [savingView, setSavingView] = createSignal(false);
  const [viewUndo, setViewUndo] = createSignal(false);
  const [replaying, setReplaying] = createSignal(false);
  let region!: HTMLDivElement;
  let register!: HTMLDivElement;
  let scroll!: HTMLDivElement;
  let grid!: HTMLTableElement;
  const documents = new Map<string, PageDocument>();
  const history: TableEdit[] = [];
  const undone: typeof history = [];
  let replayQueue = Promise.resolve();
  onCleanup(() => {
    void replayQueue.then(() => {
      for (const doc of documents.values()) doc.release();
    });
  });
  const pendingWrites = new Set<Promise<void>>();
  const focusCell = (rowId: string | null, fieldId: string | null, takeFocus = true) => {
    if (!rowId) return;
    if (narrow()) {
      const card = region?.querySelector<HTMLElement>(
        `.table-card[data-block-id="${rowId}"]:not([hidden]) .table-card-title`,
      );
      if (takeFocus) card?.focus({ preventScroll: true });
      card?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const cell = region?.querySelector<HTMLElement>(
      `tr[data-block-id="${rowId}"]:not([hidden]) ${fieldId ? `[data-field-id="${fieldId}"]` : '.table-title-column.table-cell'}`,
    );
    if (takeFocus) cell?.focus({ preventScroll: true });
    if (cell && grid.offsetWidth) {
      const bounds = cell.getBoundingClientRect();
      const frame = scroll.getBoundingClientRect();
      const header = grid.tHead!.rows[0]!.cells[0]!.getBoundingClientRect();
      if (bounds.top < header.bottom) scroll.scrollTop -= header.bottom - bounds.top;
      else if (bounds.bottom > frame.bottom) scroll.scrollTop += bounds.bottom - frame.bottom;
      if (fieldId) {
        const stickyWidth = grid.tHead!.rows[0]!.cells[0]!.getBoundingClientRect().width;
        scroll.scrollLeft = cellScrollLeft(
          scroll.scrollLeft,
          bounds.left,
          bounds.right,
          frame.left,
          frame.right,
          stickyWidth,
        );
      }
    }
  };
  let scrollReport = 0;
  onCleanup(() => cancelAnimationFrame(scrollReport));
  let columnFrame = 0;
  onCleanup(() => cancelAnimationFrame(columnFrame));
  const message = (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason));
  const viewId = createMemo(() => props.target.viewId);
  const savedViews = createSavedViewController<View, Query>({
    workshop: props.workshop,
    topic: 'views',
    viewId,
    list: signal => props.workshop.api.views(signal),
    get: (id, signal) => props.workshop.api.view(id, signal),
    saveOperation: ({ id, baseRevision, name, query }) => ({
      op: 'save_view',
      id,
      base_revision: baseRevision,
      name,
      query,
    }),
    deleteOperation: ({ id, baseRevision }) => ({
      op: 'delete_view',
      id,
      base_revision: baseRevision,
    }),
    onError: setError,
  });
  const { views, refetchViews, saved, setSaved, refetchSaved, deleted } = savedViews;
  const deleting = () => savedViews.deleting() || deletingRow();
  const scrollHost = () => (narrow() ? register : scroll);

  const queryState = createTableQueryState({
    workshop: props.workshop,
    initialQuery: props.view.query,
    targetQuery: () => props.target.query,
    targetViewId: viewId,
    saved,
    viewScroll: () => ({ scroll: props.view.scroll, horizontalScroll: props.view.horizontalScroll }),
    scroll: () => scroll,
    scrollHost,
    showResult: next => {
      const active = document.activeElement;
      const cell = active?.closest<HTMLElement>('.table-cell');
      const rowId = cell?.closest<HTMLElement>('tr')?.dataset.blockId;
      const fieldId = cell?.dataset.fieldId ?? null;
      const restore = !!cell && region.contains(cell);
      const moving = () =>
        queryState.result() && queryState.result()!.rows.length <= 300
          ? Array.from(region.querySelectorAll<HTMLElement>('tbody tr[data-block-id]:not([hidden])'))
          : [];
      glide(moving, () => queryState.setResult(next));
      if (restore && rowId) focusCell(rowId, fieldId, document.activeElement !== active);
    },
    setError,
    message,
    onUpdateQuery: next => updateQuery(next),
    onReportView: value => reportView(value),
    onMeasureEdge: () => columnResize.measureEdge(),
  });
  const {
    query,
    setQuery,
    search,
    setSearch,
    scheduleSearch,
    clearSearchTimer,
    result,
    definitions,
    setDefinitions,
    type,
    indexTotal,
    loading,
    appending,
    pageSize,
    canAppend,
    columnSearch,
    setColumnSearch,
    initialColumns,
    setInitialColumns,
    fields,
    pickerFields,
    fieldGroups,
    fieldItems,
    columnChoices,
    fieldById,
    definedFieldName,
    fieldName,
    missingFields,
    labelSort,
    labelFilter,
    members,
    groupedRows,
    navigableRows,
    sourceField,
    sourcesByRow,
    typeKind,
    rowKind,
    atDefault,
    changed,
    title,
    kindTable,
    purposeShown,
    countLabel,
    rowNoun,
    queryParts,
    summary,
    census,
    required,
    gaps,
    showMissing,
    refreshCells,
    appendRows,
  } = queryState;

  const columnResize = createColumnResize({
    initialTitleWidth:
      props.view.query.columns?.find(column => column.key === '@title')?.width ?? props.view.titleWidth,
    initialHiddenFields: props.view.hiddenFields,
    query,
    result,
    initialColumns,
    fieldById,
    sourceField,
    scroll: () => scroll,
    grid: () => grid,
    onReportView: () => reportView(),
    onUpdateQuery: next => updateQuery(next),
  });
  const {
    hiddenFields,
    setHiddenFields,
    titleWidth,
    setTitleWidth,
    visibleColumns,
    showRefs,
    recipeColumns,
    columnWidth,
    edge,
    setEdge,
    measureEdge,
    showMoreColumns,
    showField,
    moveColumn,
    resizeColumn,
  } = columnResize;

  createEffect(() => {
    setFocused(retainCell(untrack(focused), navigableRows(), visibleColumns()));
  });
  const reportView = (value = query()) =>
    props.onViewChange({
      query: copyQuery(value.columns || !initialColumns() ? value : { ...value, columns: recipeColumns() }),
      scroll: scrollHost()?.scrollTop ?? props.view.scroll,
      hiddenFields: [...hiddenFields()],
      titleWidth: titleWidth(),
      horizontalScroll: scroll?.scrollLeft ?? props.view.horizontalScroll ?? 0,
    });
  const toggleGroup = (key: string) => {
    const group = query().group;
    if (!group) return;
    const collapsed = group.collapsed ?? [];
    updateQuery({
      ...query(),
      group: {
        ...group,
        collapsed: collapsed.includes(key) ? collapsed.filter(value => value !== key) : [...collapsed, key],
      },
    });
  };
  const phoneFields = (row: QueryRow) =>
    phoneFieldsForRow({
      row,
      query: query(),
      phone: phone(),
      visibleColumns: visibleColumns(),
      fields: fields(),
      sourceField: sourceField(),
      fieldById,
    });
  const updateQuery = (next: Query) => {
    const value = retainFieldNames(next.columns || !initialColumns() ? next : { ...next, columns: recipeColumns() });
    const columns = value.columns?.filter(column => column.key !== '@title').map(column => column.key);
    const previous = visibleColumns();
    const resetScroll =
      value.source !== query().source ||
      (!!columns && (columns.length !== previous.length || columns.some((id, index) => id !== previous[index])));
    setQuery(copyQuery(value));
    if (value.layout !== 'table') setEdge({ hidden: 0, height: 0 });
    reportView(value);
    if (resetScroll && scroll) {
      scroll.scrollLeft = 0;
      cancelAnimationFrame(columnFrame);
      columnFrame = requestAnimationFrame(() => {
        scroll.scrollLeft = 0;
        measureEdge();
        reportView();
      });
    }
  };
  const submit = async (operation: Operation) => {
    await props.workshop.commit([operation]);
  };
  const withDocument = async (pageId: string, action: (doc: PageDocument) => void | Promise<void>) => {
    let doc = documents.get(pageId);
    if (!doc) {
      doc = props.workshop.open(pageId);
      documents.set(pageId, doc);
    }
    await doc.ready();
    await action(doc);
  };
  const appendField = async (fieldId: string) => {
    const currentType = type();
    if (!currentType || !query().type) return;
    if (currentType.fields.includes(fieldId)) return;
    await submit({
      op: 'set_type_fields',
      type_id: currentType.page.id,
      base_revision: currentType.page.revision,
      fields: [...currentType.fields, fieldId],
    });
  };
  const saveView = async (name: string, rename = false) => {
    const previous = saved();
    const id = rename ? previous!.id : ulid();
    const value = rename ? previous!.query : { ...copyQuery(query()), columns: recipeColumns() };
    await submit({ op: 'save_view', id, base_revision: rename ? previous!.revision : null, name, query: value });
    setSaved(await props.workshop.api.view(id));
    if (!rename) updateQuery(value);
    await refetchViews();
    props.onTargetChange({ kind: 'table', typeId: value.type, viewId: id, query: copyQuery(value) });
    setPopup(null);
  };
  const saveChanges = async () => {
    const value = saved();
    if (!value || savingView() || !changed()) return;
    setSavingView(true);
    const pending = (async () => {
      const next = { ...value, query: copyQuery(query()), revision: value.revision + 1 };
      await submit({
        op: 'save_view',
        id: value.id,
        base_revision: value.revision,
        name: value.name,
        query: next.query,
      });
      history.push({ kind: 'view', before: value, after: next, revision: next.revision });
      undone.length = 0;
      setViewUndo(true);
      setRowUndo(false);
      setSaved(next);
      await refetchViews();
    })();
    pendingWrites.add(pending);
    try {
      await pending;
    } finally {
      pendingWrites.delete(pending);
      setSavingView(false);
    }
  };
  const removeMissingField = async (id: string) => {
    updateQuery(removeQueryField(query(), id));
    if (saved()) await saveChanges();
  };
  const deleteView = async (value: View) => {
    setError('');
    if (await savedViews.remove(value)) {
      setPopup(null);
      props.onTargetChange({ kind: 'table', typeId: query().type, viewId: null, query: copyQuery(query()) });
    }
  };
  const undoDelete = async () => {
    const restored = await savedViews.undoDelete();
    if (!restored) return;
    props.onTargetChange({ kind: 'table', typeId: query().type, viewId: restored.id, query: copyQuery(query()) });
    refetchSaved();
  };
  const createField = async (name: string, addColumn: boolean) => {
    const all = await props.workshop.api.fields();
    let fieldId = all.fields.find(field => field.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())?.id;
    if (!fieldId)
      await withDocument(all.page_id, async doc => {
        const written = doc.edit({ kind: 'addField', name: name.trim(), value: 'text' });
        if (!written.ok) throw new Error(written.reason);
        fieldId = written.created[0]!;
        // A query or template can only refer to the definition after its document commits.
        const committed = Promise.withResolvers<void>();
        createRoot(dispose => {
          createEffect(() => {
            if ((doc.block(fieldId!)?.revision ?? 0) > 0) {
              dispose();
              committed.resolve();
            } else if (doc.saveState() === 'error' || doc.saveState() === 'conflict') {
              dispose();
              committed.reject(new Error(doc.saveMessage()));
            }
          });
        });
        await committed.promise;
      });
    if (addColumn) await appendField(fieldId!);
    setDefinitions(await props.workshop.api.fields());
    setPopup(null);
    return fieldId!;
  };
  const switchView = (view: View | null) => {
    const next = view?.query ?? untouchedQuery(query());
    if (next.note_kind && next.note_view?.layout === 'index') {
      props.onOpen({ kind: 'index', key: next.note_kind, viewId: view?.id, query: copyQuery(next) }, false);
      setPopup(null);
      return;
    }
    setInitialColumns(undefined);
    clearSearchTimer();
    setSearch(next.text ?? '');
    updateQuery(noteTableQuery(next));
    setSaved(view ?? undefined);
    setTitleWidth(clampTitleWidth(next.columns?.find(column => column.key === '@title')?.width));
    setSelectedRow(null);
    setFocused({ rowId: null, fieldId: null });
    setPopup(null);
    props.onTargetChange({ kind: 'table', typeId: next.type, viewId: view?.id ?? null, query: copyQuery(next) });
    if (scroll) {
      scrollHost().scrollTop = 0;
      scroll.scrollLeft = 0;
    }
    reportView(next);
  };
  const viewMenu = (anchor: HTMLElement) =>
    setPopup({
      kind: 'menu',
      anchor,
      label: 'Views',
      header: (
        <>
          <div class="table-popup-heading">Views</div>
          <div class="table-popup-note">
            {title() || 'All atoms'} ·{' '}
            {query().filters.length
              ? `${query().filters.length} ${query().filters.length === 1 ? 'filter' : 'filters'}`
              : 'No filters'}
            <Show when={query().sort.length}> · {query().sort.map(labelSort).join(', ')}</Show>
          </div>
        </>
      ),
      items: [
        {
          label: title() ? `All ${title()}` : 'All atoms',
          checked: atDefault(),
          shortcut: !props.target.viewId && !atDefault() ? 'Modified' : undefined,
          action: () => switchView(null),
        },
        ...(views() ?? [])
          .filter(
            view => view.query.type === query().type && (view.query.source ?? 'notes') === (query().source ?? 'notes'),
          )
          .map(
            (view): MenuItem => ({
              label: view.name,
              checked: queriesEqual(query(), view.query),
              shortcut: view.id === props.target.viewId && !queriesEqual(query(), view.query) ? 'Modified' : undefined,
              action: () => switchView(view),
            }),
          ),
        {
          label: 'Save as view…',
          section: 'View actions',
          action: () => setPopup({ kind: 'name', anchor, action: 'save' }),
        },
        ...(narrow() || !purposeShown()
          ? [
              {
                label: query().purpose ? 'Edit purpose…' : 'Add purpose…',
                action: () => setPopup({ kind: 'purpose' as const, anchor }),
              },
            ]
          : []),
        ...(!props.target.viewId && !atDefault() ? [{ label: 'Revert changes', action: () => switchView(null) }] : []),
        ...(props.target.viewId
          ? [
              ...(changed()
                ? [
                    {
                      label: 'Save changes',
                      disabledReason: savingView() ? 'Saving…' : undefined,
                      action: () => {
                        void saveChanges().catch(message);
                      },
                    },
                    {
                      label: 'Revert changes',
                      action: () => {
                        const value = saved();
                        if (value) switchView(value);
                      },
                    },
                  ]
                : []),
              {
                label: 'Rename view…',
                disabledReason: !saved() ? 'Loading…' : undefined,
                action: () => setPopup({ kind: 'name', anchor, action: 'rename' }),
              },
              {
                label: 'Embed on atom…',
                disabledReason: !saved() ? 'Loading…' : undefined,
                action: () => {
                  const view = saved();
                  if (view) setPopup({ kind: 'embed-page', anchor, view });
                },
              },
              {
                label: props.workshop.confirmViewDelete() ? 'Delete view…' : 'Delete view',
                icon: 'trash' as const,
                danger: true,
                disabledReason: !saved() ? 'Loading…' : undefined,
                action: () => {
                  const view = saved();
                  if (view) {
                    setError('');
                    if (props.workshop.confirmViewDelete()) setPopup({ kind: 'delete', anchor, view });
                    else void deleteView(view);
                  }
                },
              },
            ]
          : []),
      ],
    });
  const showFilter = (anchor: HTMLElement, field = '') => {
    const initial = field || (narrow() ? (visibleColumns().find(id => fieldById(id)?.kind === 'choice') ?? '') : '');
    setPopup({ kind: 'filter', anchor, field: initial });
  };
  const columnMenu = (anchor: HTMLElement, field: FieldDefinition | undefined) => {
    const key: Pick<SortKey, 'by' | 'field'> = field ? { by: 'field', field: field.id } : { by: 'title', field: null };
    const sorted = query().sort.findIndex(sort => sort.by === key.by && sort.field === key.field);
    setPopup({
      kind: 'menu',
      anchor,
      label: field ? fieldLabel(field) : 'Title',
      items: [
        { label: 'Sort ascending', action: () => updateQuery(chooseSort(query(), key, 'asc')) },
        { label: 'Sort descending', action: () => updateQuery(chooseSort(query(), key, 'desc')) },
        ...(sorted >= 0 ? [{ label: 'Clear sort', action: () => updateQuery(removeSort(query(), sorted)) }] : []),
        ...(field
          ? [
              { label: 'Filter…', action: () => showFilter(anchor, field.id) },
              { label: 'Hide column', action: () => showField(field.id, false) },
              {
                label: 'Move left',
                disabledReason: visibleColumns().indexOf(field.id) <= 0 ? 'This is the first column' : undefined,
                action: () => moveColumn(field.id, -1),
              },
              {
                label: 'Move right',
                disabledReason:
                  visibleColumns().indexOf(field.id) >= visibleColumns().length - 1
                    ? 'This is the last column'
                    : undefined,
                action: () => moveColumn(field.id, 1),
              },
              ...(!field.id.startsWith('@')
                ? [
                    {
                      label: 'Edit field…',
                      section: 'Definition',
                      action: () => props.onOpen({ kind: 'field', fieldId: field.id }, false),
                    },
                    ...(query().type && type()?.fields.includes(field.id)
                      ? [
                          {
                            label: 'Remove from template',
                            section: 'Tag template',
                            icon: 'close' as const,
                            disabledReason: required().has(field.id) ? requiredReason(type()!, field.name) : undefined,
                            action: () => {
                              const current = type()!;
                              void submit({
                                op: 'set_type_fields',
                                type_id: current.page.id,
                                base_revision: current.page.revision,
                                fields: current.fields.filter(id => id !== field.id),
                              }).catch(message);
                            },
                          },
                        ]
                      : []),
                  ]
                : []),
            ]
          : []),
      ],
    });
  };
  const addColumnMenu = (anchor: HTMLElement) => {
    anchor.focus({ preventScroll: true });
    setPopup({
      kind: 'menu',
      anchor,
      label: 'Add field to tag template',
      items: [
        ...fields()
          .filter(field => !type()?.fields.includes(field.id))
          .map(
            (field): MenuItem => ({
              label: fieldLabel(field),
              disabledReason: !query().type ? 'Open a tag to add fields' : undefined,
              action: () => {
                void appendField(field.id).catch(message);
              },
            }),
          ),
        {
          label: 'New field…',
          disabledReason: !query().type ? 'Open a tag to add fields' : undefined,
          action: () => {
            anchor.focus({ preventScroll: true });
            setPopup({ kind: 'name', anchor, action: 'field', addColumn: true });
          },
        },
      ],
    });
  };
  // A field already sorted on is checked; choosing it again flips its direction.
  const sortMenu = (anchor: HTMLElement) =>
    setPopup({
      kind: 'menu',
      anchor,
      label: 'Sort',
      items: fieldItems(field => ({
        checked: query().sort.some(key => key.by === 'field' && key.field === field.id),
        action: () => updateQuery(chooseSort(query(), { by: 'field', field: field.id })),
      })),
    });
  const groupMenu = (anchor: HTMLElement) =>
    setPopup({
      kind: 'menu',
      anchor,
      label: 'Group',
      items: [
        {
          label: 'No grouping',
          checked: !query().group,
          action: () =>
            updateQuery({
              ...query(),
              group: undefined,
              ...(query().note_view ? { note_view: { ...query().note_view!, grouping: 'letter' } } : {}),
            }),
        },
        // Every title is its own group, so Title is not offered.
        ...fieldItems(
          field => ({
            checked: query().group?.key === field.id,
            action: () =>
              updateQuery({
                ...query(),
                group: { key: field.id, collapsed: [] },
                ...(query().note_view
                  ? {
                      note_view: {
                        ...query().note_view!,
                        grouping: field.id.startsWith('@') ? 'letter' : `field:${field.id}`,
                      },
                    }
                  : {}),
              }),
          }),
          '@title',
        ),
      ],
    });
  const sourceMenu = (anchor: HTMLElement) =>
    setPopup({
      kind: 'menu',
      anchor,
      label: 'Source',
      items: querySources.map(source => ({
        label: source.name,
        checked: (query().source ?? 'notes') === source.key,
        action: () => {
          const next = { ...typeQuery(null), source: source.key };
          setSearch('');
          setHiddenFields([]);
          setInitialColumns(undefined);
          updateQuery(next);
          setPopup(null);
          props.onTargetChange({ kind: 'table', typeId: null, viewId: null, query: next });
          setSaved(undefined);
        },
      })),
    });
  const openRow = (row: QueryRow, beside: boolean) => {
    setSelectedRow(row.block.block.id);
    const alongside = beside || listOpensBeside(null, !!props.neighbour);
    if (query().source === 'highlights') {
      void props.workshop.api
        .capabilities(row.block.block.id)
        .then(capabilities => {
          const citation = capabilities.citations?.[0];
          if (!citation) throw new Error('This highlight has no passage.');
          props.onOpen(
            { kind: 'reader', sourceId: citation.source_id, snapshotId: citation.snapshot_id, citationId: citation.id },
            alongside,
          );
        })
        .catch(message);
    } else
      props.onOpen(
        {
          kind: 'page',
          pageId: row.block.page.id,
          ...(row.block.block.kind === 'block' ? { blockId: row.block.block.id } : {}),
        },
        alongside,
      );
  };
  const startRename = (row: QueryRow) => {
    setPopup(null);
    setError('');
    setRowNotice(undefined);
    setSelectedRow(row.block.block.id);
    setRenaming({ row, text: props.workshop.lookup(row.block.block.id)()?.text ?? row.block.block.text });
  };
  const commitTitle = async (returnFocus = false) => {
    const current = renaming();
    if (!current) return;
    const text = current.text.trim();
    if (!text) {
      setError('A title cannot be empty.');
      return;
    }
    const id = current.row.block.block.id;
    const duplicate =
      current.row.block.block.kind === 'page'
        ? props.workshop
            .roots()
            .some(root => root.kind === 'page' && root.id !== id && titleKey(root.text) === titleKey(text))
        : current.row.block.block.kind === 'journal' &&
          props.workshop.roots().some(root => root.kind === 'journal' && root.id !== id && root.text === text);
    if (duplicate) {
      setError('An atom already has that title.');
      return;
    }
    setRenaming(null);
    if (returnFocus) focusCell(id, null);
    const pending = withDocument(current.row.block.page.id, async doc => {
      if (doc.block(id)?.text === text) return;
      const changed = doc.edit({ kind: 'text', id, text });
      if (!changed.ok) throw new Error(changed.reason);
      history.push({ kind: 'cell', doc, rowId: id, fieldId: null });
      undone.length = 0;
      setViewUndo(false);
      setRowUndo(false);
      await doc.flush();
      await refreshCells();
    });
    pendingWrites.add(pending);
    try {
      await pending;
    } catch (reason) {
      message(reason);
    } finally {
      pendingWrites.delete(pending);
    }
  };
  const deleteRow = async (row: QueryRow) => {
    if (deleting()) return;
    setDeletingRow(true);
    setError('');
    setRowNotice(undefined);
    const block = row.block.block;
    try {
      if (block.kind !== 'block') {
        if (!props.onDeletePages) throw new Error('Atom deletion is unavailable.');
        await props.onDeletePages([{ id: block.id, title: block.text }]);
      } else
        await withDocument(row.block.page.id, async doc => {
          const removed = doc.edit({ kind: 'delete', ids: [block.id] });
          if (!removed.ok) throw new Error(removed.reason);
          history.push({ kind: 'cell', doc, rowId: block.id, fieldId: null });
          undone.length = 0;
          setViewUndo(false);
          await doc.flush();
          setRowUndo(true);
        });
      setPopup(null);
      await refreshCells();
      focusCell(focused().rowId, focused().fieldId);
    } catch (reason) {
      message(reason);
    } finally {
      setDeletingRow(false);
    }
  };
  const rowItems = (row: QueryRow, anchor: HTMLElement): MenuItem[] => [
    { label: 'Open', action: () => openRow(row, false) },
    // A phone shows one pane, so opening beside would only repeat Open.
    ...(phone() ? [] : [{ label: 'Open beside', action: () => openRow(row, true) }]),
    { label: 'Rename…', action: () => startRename(row) },
    {
      label: 'Delete…',
      icon: 'trash',
      danger: true,
      disabledReason:
        row.block.block.kind !== 'block' && !props.onDeletePages ? 'Atom deletion is unavailable.' : undefined,
      action: () => {
        setError('');
        setPopup({ kind: 'delete-row', anchor, row });
      },
    },
  ];
  const rowMenu = (row: QueryRow, anchor: HTMLElement) => {
    setSelectedRow(row.block.block.id);
    setPopup({
      kind: 'menu',
      anchor,
      label: 'Row actions',
      title: 'Row actions',
      context: plainText(row.block.block.text, id => props.workshop.lookup(id)),
      items: rowItems(row, anchor),
    });
  };
  /** A long press on a phone card lifts it and opens the same actions under it. */
  const rowContext = (row: QueryRow, card: HTMLElement) =>
    openContextMenu({
      source: card,
      label: `Actions for ${plainText(row.block.block.text, id => props.workshop.lookup(id))}`,
      items: rowItems(row, card),
    });
  const revealNewRow = async (target: Extract<OpenTarget, { kind: 'page' }>, beside: boolean) => {
    setPopup(null);
    if (beside) {
      props.onOpen(target, true);
      return;
    }
    pendingCaretInput.cancel();
    const id = target.pageId;
    await refreshCells();
    const row = result()?.rows.find(row => row.block.block.id === id);
    setRowNotice({ id, title: props.workshop.lookup(id)()?.text ?? row?.block.block.text ?? 'Atom' });
    if (row) {
      // Read-only attributes and phone cards have no inline field editor to receive focus.
      const field =
        target.caretId && !narrow()
          ? visibleColumns()
              .map(fieldById)
              .find(
                field =>
                  field && !field.id.startsWith('@') && !(row.values[field.id] ?? []).some(value => value.text.trim()),
              )
          : undefined;
      setFocused({ rowId: id, fieldId: field?.id ?? null });
      setSelectedRow(id);
      focusCell(id, field?.id ?? null);
      const cell =
        field &&
        region.querySelector<HTMLElement>(`tr[data-block-id="${id}"]:not([hidden]) [data-field-id="${field.id}"]`);
      // A checkbox is already editable by Space; entering it must not toggle its value.
      if (field && cell && field.kind !== 'checkbox') startEdit(row, field, cell);
    } else region.focus({ preventScroll: true });
  };
  const openField = (row: QueryRow, field: FieldDefinition) => {
    void withDocument(row.block.page.id, doc => {
      const owner = row.block.block;
      const entries = doc.outline
        .children(owner.id)
        .filter(id => fieldEntryId(doc.block(id)?.text ?? '') === field.id && !doc.block(id)?.archived);
      props.onOpen(
        {
          kind: 'page',
          pageId: owner.page_id,
          blockId: entries.length === 1 ? entries[0] : owner.kind === 'block' ? owner.id : undefined,
        },
        true,
      );
    }).catch(message);
  };
  const openPill = async (
    row: QueryRow,
    field: FieldDefinition,
    value: FieldValue,
    anchor: HTMLElement,
    beside: boolean,
  ) => {
    if (field.kind === 'choice' && !beside) {
      anchor.closest<HTMLElement>('.table-cell')?.focus({ preventScroll: true });
      setPopup({ kind: 'value', row, field, value, anchor });
      return;
    }
    const id = fieldEntryId(value.text);
    if (!id) return;
    const target = props.workshop.lookup(id)() ?? (await props.workshop.api.block(id));
    props.onOpen(
      { kind: 'page', pageId: target.page_id, ...(target.kind === 'block' ? { blockId: target.id } : {}) },
      beside || listOpensBeside(null, !!props.neighbour),
    );
  };
  const writeCell = async (
    row: QueryRow,
    field: FieldDefinition,
    text: string,
    value = row.values[field.id]?.[0],
    option?: string,
    relationPick?: RelationPickIntent,
  ) => {
    const pending = withDocument(row.block.page.id, async doc => {
      if (!option && !relationPick && (value?.text ?? '') === text) return;
      const target = { field, ownerId: row.block.block.id, valueId: value?.id };
      if (option) await createOptionValue(props.workshop, doc, target, option);
      else writeFieldValue(doc, target, text, undefined, relationPick);
      history.push({ kind: 'cell', doc, rowId: row.block.block.id, fieldId: field.id });
      undone.length = 0;
      setViewUndo(false);
      setRowUndo(false);
      await doc.flush();
      await refreshCells();
    });
    pendingWrites.add(pending);
    try {
      await pending;
    } finally {
      pendingWrites.delete(pending);
    }
  };
  const startEdit = (row: QueryRow, field: FieldDefinition, anchor: HTMLElement) => {
    if (taskFieldName(field)) {
      void withDocument(row.block.page.id, doc => {
        if (taskFieldName(field) === 'project' && !doc.block(row.block.block.id)?.task)
          setPopup({ kind: 'value', row, field, anchor });
        else setPopup({ kind: 'task-field', row, field, anchor, doc });
      }).catch(message);
      return;
    }
    if (field.id.startsWith('@')) return;
    const values = row.values[field.id] ?? [];
    if (values.length > 1) {
      openField(row, field);
      return;
    }
    if (field.kind === 'checkbox') {
      void writeCell(row, field, checkboxValue(values[0]?.text ?? '') ? 'no' : 'yes').catch(message);
      return;
    }
    if (hasValueEditor(field, values[0]?.text ?? '', props.workshop.todayDate())) {
      setPopup({ kind: 'value', row, field, anchor });
      return;
    }
    if (
      values.some(value => textTokens(value.text).some(token => token.kind === 'reference' || token.kind === 'tag'))
    ) {
      openField(row, field);
      return;
    }
    // The editor opens at the height the value had, so a clamped multi-line cell does not collapse the row under it.
    const cellStyle = getComputedStyle(anchor);
    setEditing({
      row,
      field,
      text: values[0]?.text ?? '',
      height: Math.max(0, anchor.clientHeight - parseFloat(cellStyle.paddingTop) - parseFloat(cellStyle.paddingBottom)),
    });
  };
  const commitEdit = async (returnFocus = false) => {
    const current = editing();
    if (!current) return;
    setEditing(null);
    // Enter keeps keyboard ownership synchronously; blur belongs to its new target.
    if (returnFocus) focusCell(current.row.block.block.id, current.field.id);
    const original = current.row.values[current.field.id]?.[0]?.text ?? '';
    if (current.text !== original) {
      try {
        await writeCell(current.row, current.field, current.text);
      } catch (reason) {
        message(reason);
      }
    }
  };
  /** Tab out of a cell editor commits it and lands on the neighboring cell, in reading order; the first and last cells stay put. */
  const advanceCell = (rowId: string, fieldId: string, backward: boolean) => {
    void commitEdit(false);
    const rows = navigableRows();
    const columns = visibleColumns();
    const row = rows.findIndex(item => item.block.block.id === rowId);
    const column = columns.indexOf(fieldId);
    if (row < 0 || column < 0) return;
    const index = Math.max(
      0,
      Math.min(rows.length * columns.length - 1, row * columns.length + column + (backward ? -1 : 1)),
    );
    const next = {
      rowId: rows[Math.floor(index / columns.length)]!.block.block.id,
      fieldId: columns[index % columns.length]!,
    };
    setFocused(next);
    focusCell(next.rowId, next.fieldId);
  };
  const runReplay = async (redo: boolean) => {
    setReplaying(true);
    try {
      // A first write may still be opening its page document. Undo follows that
      // operation, not a timer or whichever history entry happened to exist.
      await Promise.all(pendingWrites);
      const source = redo ? undone : history;
      const entry = source.at(-1);
      if (!entry) return;
      if (entry.kind === 'view') {
        const value = redo ? entry.after : entry.before;
        await submit({
          op: 'save_view',
          id: value.id,
          base_revision: entry.revision,
          name: value.name,
          query: copyQuery(value.query),
        });
        entry.revision += 1;
        if (props.target.viewId === value.id) {
          clearSearchTimer();
          setSearch(value.query.text ?? '');
          updateQuery(value.query);
          setSaved({ ...value, revision: entry.revision });
        }
        await refetchViews();
      } else if (entry.kind === 'created-row') {
        if (redo) await props.workshop.restorePage(entry.pageId);
        else await props.workshop.deletePage(entry.pageId, { retainHistory: true });
        setRowNotice(undefined);
        await refreshCells();
        const next = redo
          ? { rowId: entry.pageId, fieldId: null }
          : retainCell(focused(), navigableRows(), visibleColumns());
        setFocused(next);
        setSelectedRow(next.rowId);
        if (next.rowId) focusCell(next.rowId, next.fieldId);
        else region.focus({ preventScroll: true });
      } else {
        redo ? entry.doc.redo() : entry.doc.undo();
        await entry.doc.flush();
        await refreshCells();
        focusCell(entry.rowId, entry.fieldId);
      }
      source.pop();
      (redo ? history : undone).push(entry);
      // Earlier updates of this view now undo against its current revision.
      if (entry.kind === 'view') {
        for (let index = source.length - 1; index >= 0; index--) {
          const previous = source[index]!;
          if (previous.kind === 'view' && previous.before.id === entry.before.id) {
            previous.revision = entry.revision;
            break;
          }
        }
      }
      setViewUndo(history.at(-1)?.kind === 'view');
      setRowUndo(false);
    } finally {
      setReplaying(false);
    }
  };
  const replayCell = (redo: boolean): Promise<void> => {
    const result = replayQueue.then(() => runReplay(redo));
    replayQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const keydown = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      (event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable="true"]'))
    )
      return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.stopPropagation();
      void replayCell(event.shiftKey).catch(message);
      return;
    }
    if (event.target instanceof HTMLElement && event.target.closest('button, a')) return;
    const current = focused();
    const rows = navigableRows();
    const columns = visibleColumns();
    const rowIndex = Math.max(
      0,
      rows.findIndex(row => row.block.block.id === current.rowId),
    );
    const columnIndex = current.fieldId ? columns.indexOf(current.fieldId) + 1 : 0;
    const row = rows[rowIndex];
    if (event.key === 'Escape') {
      region.focus();
      event.preventDefault();
      return;
    }
    if (event.key === 'F2' && !current.fieldId && row && rowKind()) {
      event.preventDefault();
      startRename(row);
      return;
    }
    const field = current.fieldId ? fieldById(current.fieldId) : undefined;
    if ((event.key === 'Enter' || (event.key === ' ' && field?.kind === 'checkbox')) && row) {
      if (!current.fieldId) openRow(row, listOpensBeside(event, !!props.neighbour));
      else if (field && event.target instanceof HTMLElement) startEdit(row, field, event.target);
      event.preventDefault();
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const nextRow =
      rows[
        Math.max(
          0,
          Math.min(rows.length - 1, rowIndex + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)),
        )
      ];
    const nextColumn = Math.max(
      0,
      Math.min(columns.length, columnIndex + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0)),
    );
    if (nextRow) {
      const next = { rowId: nextRow.block.block.id, fieldId: columns[nextColumn - 1] ?? null };
      setFocused(next);
      focusCell(next.rowId, next.fieldId);
    }
    event.preventDefault();
  };
  // Keep value components mounted when definitions refresh: remounting their
  // measured More controls briefly shrinks the grid and clamps its scroll.
  const renderValue = (row: QueryRow, id: string, hideCount = false, prose = false) => (
    <Show
      when={id.startsWith('@') || Object.hasOwn(row.attributes ?? {}, id)}
      fallback={
        <TableFieldValue
          field={fieldById(id)}
          values={row.values[id] ?? []}
          workshop={props.workshop}
          today={prose ? props.workshop.todayDate() : undefined}
          hideCount={hideCount || id === sourceField()?.id}
          onPill={(value, anchor, beside) => {
            const field = fieldById(id);
            if (field) void openPill(row, field, value, anchor, beside).catch(message);
          }}
          onSources={(anchor, sources) => setPopup({ kind: 'sources', anchor, label: fieldName(id), sources })}
        />
      }
    >
      <TableAttributeValue
        field={fieldById(id)}
        today={prose ? props.workshop.todayDate() : undefined}
        values={row.attributes?.[id] ?? []}
        workshop={props.workshop}
        onOpen={props.onOpen}
      />
    </Show>
  );
  const renderTitle = (row: QueryRow, phone = false) => (
    <Show
      when={phone === narrow() && renaming()?.row.block.block.id === row.block.block.id}
      fallback={
        <TableCellText>
          {expanded => (
            <BlockText
              text={preview(props.workshop.lookup(row.block.block.id)()?.text ?? row.block.block.text, expanded)}
              workshop={props.workshop}
              interactive={false}
              cards
            />
          )}
        </TableCellText>
      }
    >
      <input
        class="input table-cell-input"
        aria-label="Edit row title"
        value={renaming()?.text ?? ''}
        ref={input =>
          queueMicrotask(() => {
            input.focus({ preventScroll: true });
            input.select();
          })
        }
        onInput={event => {
          const text = event.currentTarget.value;
          setRenaming(current => (current ? { ...current, text } : null));
          setError('');
        }}
        onKeyDown={event => {
          if (event.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            void commitTitle(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setRenaming(null);
            focusCell(row.block.block.id, null);
          }
        }}
        onBlur={() => {
          void commitTitle();
        }}
      />
    </Show>
  );
  const renderCell = (row: QueryRow, id: string) => {
    const field = () => fieldById(id);
    const current = () => editing();
    return (
      <Show
        when={current()?.row.block.block.id === row.block.block.id && current()?.field.id === id}
        fallback={
          <Show
            when={required().has(id) && !row.values[id]?.length && !row.attributes?.[id]?.length}
            fallback={renderValue(row, id)}
          >
            <span class="table-needed">needed</span>
          </Show>
        }
      >
        <PlainValueInput
          class="table-cell-input"
          field={field()}
          text={current()?.text ?? ''}
          minHeight={current()?.height}
          onInput={text => setEditing(value => (value ? { ...value, text } : null))}
          onCommit={returnFocus => {
            void commitEdit(returnFocus);
          }}
          onCancel={() => {
            setEditing(null);
            focusCell(row.block.block.id, id);
          }}
          onAdvance={backward => advanceCell(row.block.block.id, id, backward)}
        />
      </Show>
    );
  };
  const renderCardCell = (row: QueryRow, field: FieldDefinition) => (
    <TableCardCell
      row={row}
      field={field}
      phone={phone()}
      sourceFieldId={sourceField()?.id}
      groupKey={query().group?.key}
      renderValue={renderValue}
      onStartEdit={startEdit}
      onOpenField={openField}
    />
  );
  const renderRefs = (row: QueryRow, card: boolean) => (
    <TableRefsButton
      sources={sourcesByRow().get(row.block.block.id) ?? []}
      card={card}
      phone={phone()}
      sourceLabel={sourceField()?.name ?? 'Source'}
      onOpenSources={(anchor, label, sources) => setPopup({ kind: 'sources', anchor, label, sources })}
    />
  );
  const phoneHead = () => (
    <TablePhoneHead
      heading={saved()?.name ?? (title() || 'All atoms')}
      census={census()}
      changed={changed()}
      purposeShown={purposeShown()}
      purpose={query().purpose ?? ''}
      gaps={gaps.latest}
      definedFieldName={definedFieldName}
      onShowMissing={showMissing}
      onPurposeChange={purpose => updateQuery({ ...query(), purpose })}
    />
  );
  const queryChips = () => (
    <TableQueryChips
      ready={!!definitions()}
      query={query()}
      labelSort={labelSort}
      labelFilter={labelFilter}
      onUpdateQuery={updateQuery}
    />
  );
  const phoneFind = () => (
    <TablePhoneFind
      query={query()}
      title={title()}
      workshop={props.workshop}
      querySheetOpen={!!querySheet()}
      chips={queryChips()}
      onOpenQuerySheet={anchor => setQuerySheet(anchor)}
      onSearch={setSearch}
      onUpdateQuery={updateQuery}
    />
  );
  const layoutMenu = (anchor: HTMLElement) =>
    setPopup({
      kind: 'menu',
      anchor,
      label: 'Layout',
      items: [
        {
          label: 'Table',
          checked: !query().layout || query().layout === 'table',
          action: () => updateQuery({ ...query(), layout: 'table' }),
        },
        ...(['register', 'matrix'] as const).map(layout => ({
          label: layout === 'register' ? 'Register' : 'Matrix',
          checked: query().layout === layout,
          disabledReason: query().source !== 'positions' ? 'Choose Perspectives to use this layout.' : undefined,
          action: () =>
            updateQuery({
              ...query(),
              layout,
              ...(layout === 'register' && !query().group ? { group: { key: '@subject', collapsed: [] } } : {}),
            }),
        })),
      ],
    });
  const layoutName = () =>
    query().layout === 'register' ? 'Register' : query().layout === 'matrix' ? 'Matrix' : 'Table';
  const showLayout = () => !kindTable() || query().source === 'positions';
  const phoneOptions = () => (
    <TablePhoneOptions
      query={query()}
      savedName={saved()?.name}
      title={title()}
      definitionsLoaded={!!definitions()}
      visibleColumnsCount={visibleColumns().length}
      columnsOpen={popup()?.kind === 'columns'}
      showLayout={showLayout()}
      layoutName={layoutName()}
      labelSort={labelSort}
      fieldName={fieldName}
      onViewMenu={viewMenu}
      onSourceMenu={sourceMenu}
      onShowFilter={anchor => showFilter(anchor)}
      onSortMenu={sortMenu}
      onGroupMenu={groupMenu}
      onLayoutMenu={layoutMenu}
      onToggleColumns={anchor => setPopup(popup()?.kind === 'columns' ? null : { kind: 'columns', anchor })}
      onOpenCardFields={anchor => setPopup({ kind: 'columns', anchor, cards: true })}
    />
  );
  const queryToolbar = () => (
    <TableQueryToolbar
      query={query()}
      title={title()}
      search={search()}
      definitionsLoaded={!!definitions()}
      narrow={narrow()}
      columnsOpen={popup()?.kind === 'columns'}
      showLayout={showLayout()}
      layoutName={layoutName()}
      fieldName={fieldName}
      workshop={props.workshop}
      chips={queryChips()}
      onUpdateQuery={updateQuery}
      onSearch={scheduleSearch}
      onSourceMenu={sourceMenu}
      onShowFilter={anchor => showFilter(anchor)}
      onSortMenu={sortMenu}
      onGroupMenu={groupMenu}
      onLayoutMenu={layoutMenu}
      onToggleColumns={anchor => setPopup(popup()?.kind === 'columns' ? null : { kind: 'columns', anchor })}
      onOpenCardFields={anchor => setPopup({ kind: 'columns', anchor, cards: true })}
      onSaveView={anchor => setPopup({ kind: 'name', anchor, action: 'save' })}
    />
  );
  onMount(() => {
    if (props.active) region.focus({ preventScroll: true });
    const coarse = window.matchMedia(coarseQuery);
    const measurePane = () => {
      const bounds = register.getBoundingClientRect();
      const style = getComputedStyle(region);
      const contentWidth =
        region.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setNarrow(coarse.matches && contentWidth < 600);
      setDockBounds({ left: bounds.left, width: bounds.width });
    };
    const paneResize = new ResizeObserver(measurePane);
    paneResize.observe(region);
    coarse.addEventListener('change', measurePane);
    measurePane();
    onCleanup(() => {
      paneResize.disconnect();
      coarse.removeEventListener('change', measurePane);
    });
    const resize = new ResizeObserver(measureEdge);
    resize.observe(scroll);
    if (grid) resize.observe(grid);
    onCleanup(() => resize.disconnect());
  });
  /** The editors a table's controls open; on a phone, while its options sheet is up, they open inside the sheet. */
  const popups = () => (
    <Show keyed when={popup()}>
      {state => (
        <>
          {state.kind === 'menu' && (
            <Menu
              anchor={state.anchor}
              label={state.label}
              title={state.title}
              context={state.context}
              header={state.header}
              items={state.items}
              onDismiss={() => setPopup(null)}
            />
          )}
          {state.kind === 'task-field' && (
            <TaskFieldEditor
              workshop={props.workshop}
              doc={state.doc}
              id={state.row.block.block.id}
              field={taskFieldName(state.field)!}
              anchor={state.anchor}
              contextDate={props.workshop.todayDate()}
              onSaved={async () => {
                history.push({
                  kind: 'cell',
                  doc: state.doc,
                  rowId: state.row.block.block.id,
                  fieldId: state.field.id,
                });
                undone.length = 0;
                setViewUndo(false);
                setRowUndo(false);
                await refreshCells();
              }}
              onDismiss={() => {
                setPopup(null);
                requestAnimationFrame(() => focusCell(state.row.block.block.id, state.field.id));
              }}
            />
          )}
          {state.kind === 'delete-row' && (
            <Popup
              anchor={state.anchor}
              placement={narrow() ? 'sheet' : 'anchor'}
              label={state.row.block.block.kind === 'block' ? 'Delete atom' : 'Delete atom'}
              onDismiss={() => {
                if (!deleting()) setPopup(null);
              }}
            >
              <p>
                Delete “{plainText(state.row.block.block.text, id => props.workshop.lookup(id))}” and all its{' '}
                {state.row.block.block.kind === 'block' ? 'children' : 'atoms'}?
              </p>
              <p class="muted">You can undo this deletion.</p>
              <Show when={error()}>
                <p class="error" role="alert">
                  {error()}
                </p>
              </Show>
              <div class="popup-actions">
                <Button disabled={deleting()} onClick={() => setPopup(null)}>
                  Cancel
                </Button>
                <Button
                  class="bordered danger"
                  disabled={deleting()}
                  onClick={() => {
                    void deleteRow(state.row);
                  }}
                >
                  Delete {state.row.block.block.kind === 'block' ? 'atom' : 'atom'}
                </Button>
              </div>
            </Popup>
          )}
          {state.kind === 'purpose' && (
            <Popup anchor={state.anchor} label="View purpose" onDismiss={() => setPopup(null)}>
              <form
                onSubmit={event => {
                  event.preventDefault();
                  setPopup(null);
                }}
              >
                <input
                  class="input"
                  aria-label="View purpose"
                  value={query().purpose ?? ''}
                  maxlength={240}
                  onInput={event => updateQuery({ ...query(), purpose: event.currentTarget.value })}
                />
                <div class="popup-actions">
                  <Button type="submit" class="bordered">
                    Done
                  </Button>
                </div>
              </form>
            </Popup>
          )}
          {state.kind === 'value' && (
            <ValueEditor
              anchor={state.anchor}
              field={fieldById(state.field.id) ?? state.field}
              owner={{ id: state.row.block.block.id, page: state.row.block.page.id }}
              text={(state.value ?? state.row.values[state.field.id]?.[0])?.text ?? ''}
              workshop={props.workshop}
              contextDate={props.workshop.todayDate()}
              onCreateOption={text => writeCell(state.row, state.field, '', state.value, text)}
              onWrite={(text, relationPick) =>
                writeCell(state.row, state.field, text, state.value, undefined, relationPick)
              }
              onError={message}
              onDismiss={() => {
                setPopup(null);
                requestAnimationFrame(() => focusCell(state.row.block.block.id, state.field.id));
              }}
            />
          )}
          {state.kind === 'filter' && (
            <FilterPopup
              anchor={state.anchor}
              fields={fieldGroups().flatMap(group => group.fields)}
              workshop={props.workshop}
              initialField={state.field}
              sheet={narrow()}
              onDismiss={() => setPopup(null)}
              onNewField={async name => createField(name, false)}
              onAdd={filter => {
                updateQuery(addFilter(query(), filter));
                setPopup(null);
              }}
            />
          )}
          {state.kind === 'name' && (
            <SavedViewNamePopup
              anchor={state.anchor}
              label={
                state.action === 'field' ? 'New field…' : state.action === 'rename' ? 'Rename view…' : 'Save as view…'
              }
              inputLabel={state.action === 'field' ? 'Field name' : 'View name'}
              emptyMessage={state.action === 'field' ? 'Name the field.' : 'Name the view.'}
              maxLength={state.action === 'field' ? null : 120}
              width={320}
              name={state.action === 'rename' ? (saved()?.name ?? '') : ''}
              onDismiss={() => setPopup(null)}
              onSave={async name => {
                if (state.action === 'field') await createField(name, !!state.addColumn);
                else await saveView(name, state.action === 'rename');
              }}
            />
          )}
          {state.kind === 'embed-page' && (
            <EmbedOnPagePicker
              anchor={state.anchor}
              view={state.view}
              workshop={props.workshop}
              onOpen={props.onOpen}
              onDismiss={() => setPopup(null)}
            />
          )}
          {state.kind === 'delete' && (
            <DeleteSavedViewPopup
              anchor={state.anchor}
              label="Delete table view?"
              name={state.view.name}
              keptNoun="Rows"
              busy={deleting()}
              error={error()}
              onDismiss={() => setPopup(null)}
              onConfirm={() => void deleteView(state.view)}
            />
          )}
          {state.kind === 'columns' && (
            <TableColumnsPopup
              pane={props.pane}
              anchor={state.anchor}
              cards={!!state.cards}
              query={query()}
              columnSearch={columnSearch()}
              onColumnSearch={setColumnSearch}
              columnChoices={columnChoices()}
              visibleColumns={visibleColumns()}
              sourceField={sourceField()}
              showRefs={showRefs()}
              titleWidth={titleWidth()}
              onSetTitleWidth={setTitleWidth}
              recipeColumns={recipeColumns}
              onShowField={showField}
              onUpdateQuery={updateQuery}
              onAddColumnMenu={addColumnMenu}
              onOpen={props.onOpen}
              onDismiss={() => setPopup(null)}
            />
          )}
          {state.kind === 'sources' && (
            <SourcesPopup
              anchor={state.anchor}
              label={state.label}
              sources={state.sources}
              workshop={props.workshop}
              onDismiss={() => setPopup(null)}
            />
          )}
        </>
      )}
    </Show>
  );
  const openNewRow = (anchor: HTMLElement) => {
    const kind = rowKind();
    if (!kind) return;
    props.onCreate(
      {
        kind: kind.key === 'question' ? 'question' : `type:${kind.key}`,
        text: '',
        lockKind: true,
      },
      anchor,
      {
        defaultBeside: matchesCoarsePointer() && !!props.neighbour,
        onCreated: pageId => {
          history.push({ kind: 'created-row', pageId });
          undone.length = 0;
          setViewUndo(false);
          setRowUndo(false);
        },
        onOpen: (target, beside) => {
          if (target.kind === 'page') void revealNewRow(target, beside).catch(message);
        },
      },
    );
  };
  return (
    <div
      ref={region}
      class="table-pane"
      style={{
        '--table-title-width': `${titleWidth()}px`,
        '--table-width': `calc(${titleWidth()}px + ${visibleColumns().map(columnWidth).join(' + ') || '0px'} + ${showRefs() ? 'var(--table-refs-width)' : '0px'})`,
      }}
      tabIndex={0}
      role="region"
      aria-label="Table"
      data-pane-pending={loading() && !result() ? '' : undefined}
      onFocusIn={props.onActivate}
      onPointerDown={props.onActivate}
      onKeyDown={keydown}
    >
      <Show when={phone() && rowKind()}>
        {kind => (
          <NavEnd>
            <NavButton
              icon="plus"
              label={`New ${kindNoun(kind())}`}
              aria-haspopup="dialog"
              onClick={event => openNewRow(event.currentTarget)}
            />
          </NavEnd>
        )}
      </Show>
      <div
        ref={register}
        class="table-register"
        onScroll={() => {
          if (narrow()) {
            cancelAnimationFrame(scrollReport);
            scrollReport = requestAnimationFrame(() => reportView());
          }
        }}
      >
        {/* Show the parent type crumb for saved views or phones; a root kind table already displays its kind in H1. */}
        <Show when={!!query().type && (phone() || (kindTable() && !!props.target.viewId))}>
          <div class="fields-register">
            <Button
              class="type-fields-crumb"
              onClick={event =>
                props.onOpen({ kind: 'index', key: typeKind()?.key ?? `type:${query().type}` }, opensBeside(event))
              }
            >
              {title() || '\u00a0'}
            </Button>
          </div>
        </Show>
        <Show when={!phone()} fallback={phoneHead()}>
          <header class="table-header" classList={{ 'table-kind-header': kindTable() }}>
            <div class="table-heading">
              <Show when={!kindTable()}>
                <div class="table-register-label">
                  <Show when={query().type}>
                    <Button
                      class="table-type-label"
                      onClick={event => props.onOpen({ kind: 'page', pageId: query().type! }, opensBeside(event))}
                    >
                      {title()}
                    </Button>
                    <span aria-hidden="true"> / </span>
                  </Show>
                  <span>Register</span>
                </div>
              </Show>
              <h1>
                <Button
                  class="table-title"
                  label="Views"
                  aria-haspopup="menu"
                  onClick={event => viewMenu(event.currentTarget)}
                >
                  <Show when={typeKind()}>{kind => <Icon name={noteKindIcon(kind())} />}</Show>
                  <span>{saved()?.name ?? (title() || 'All atoms')}</span>
                  <Icon name="down" />
                </Button>
              </h1>
              <Show when={purposeShown()}>
                <input
                  class="table-purpose"
                  aria-label="View purpose"
                  placeholder="Add a one-line purpose…"
                  value={query().purpose ?? ''}
                  maxlength={240}
                  onChange={event => updateQuery({ ...query(), purpose: event.currentTarget.value.trim() })}
                />
              </Show>
              <Show when={narrow()}>
                <p class="table-summary">
                  {summary()}
                  <Show when={changed()}>
                    {' '}
                    · <span class="table-modified">Modified</span>
                  </Show>
                </p>
              </Show>
            </div>
            <div class="table-view-status">
              <Show
                when={props.target.viewId && saved()}
                fallback={<Show when={result()}>{rows => <>{countLabel(rows().total)}</>}</Show>}
              >
                <span>{changed() ? 'Modified' : 'Saved view'}</span>
                <Show when={changed()}>
                  <Button
                    disabled={savingView()}
                    onClick={() => {
                      void saveChanges().catch(message);
                    }}
                  >
                    Save changes
                  </Button>
                  <Button
                    onClick={() => {
                      const value = saved();
                      if (value) switchView(value);
                    }}
                  >
                    Revert changes
                  </Button>
                </Show>
              </Show>
              <RequiredGaps gaps={gaps.latest} name={definedFieldName} onShow={showMissing} />
            </div>
            <Show when={rowKind()}>
              {kind => (
                <Button
                  class="bordered"
                  icon="plus"
                  aria-haspopup="dialog"
                  onClick={event => openNewRow(event.currentTarget)}
                >
                  New {kindNoun(kind())}…
                </Button>
              )}
            </Show>
          </header>
        </Show>
        <Show when={query().type}>
          {typeId => (
            <TypeModeTabs
              active="table"
              indexCount={missingFields().length ? undefined : indexTotal()}
              tableCount={missingFields().length ? undefined : result()?.total}
              fieldsCount={type()?.fields.length}
              cardsCount={type()?.card_templates}
              onCards={event => props.onOpen({ kind: 'cards', typeId: typeId() }, opensBeside(event))}
              onIndex={event =>
                props.onOpen(
                  {
                    kind: 'index',
                    key: typeKind()?.key ?? `type:${typeId()}`,
                    viewId: props.target.viewId,
                    query: {
                      ...copyQuery(query()),
                      note_kind: typeKind()?.key ?? `type:${typeId()}`,
                      note_view: { layout: 'index', grouping: query().note_view?.grouping ?? 'letter' },
                    },
                  },
                  opensBeside(event),
                )
              }
              onTable={event =>
                props.onOpen(
                  { kind: 'table', typeId: typeId(), viewId: props.target.viewId, query: copyQuery(query()) },
                  opensBeside(event),
                )
              }
              onFields={event => props.onOpen({ kind: 'fields', typeId: typeId() }, opensBeside(event))}
            />
          )}
        </Show>
        <Show when={query().note_kind && !query().type}>
          <div class="type-mode-tabs mode-tabs tab-strip" role="group" aria-label="Atom view">
            <Button
              onClick={event =>
                props.onOpen(
                  {
                    kind: 'index',
                    key: query().note_kind!,
                    viewId: props.target.viewId,
                    query: {
                      ...copyQuery(query()),
                      note_view: { layout: 'index', grouping: query().note_view?.grouping ?? 'letter' },
                    },
                  },
                  opensBeside(event),
                )
              }
            >
              List <span class="faint">{missingFields().length ? undefined : result()?.total}</span>
            </Button>
            <Button aria-pressed="true">
              Table <span class="faint">{missingFields().length ? undefined : result()?.total}</span>
            </Button>
          </div>
        </Show>
        <Show when={phone()}>{phoneFind()}</Show>
        <Show when={!narrow()}>{queryToolbar()}</Show>
        <Show when={narrow() && !phone()}>
          <div class="table-query-bar" style={{ left: `${dockBounds().left}px`, width: `${dockBounds().width}px` }}>
            <label class="table-query-find">
              <Icon name="search" />
              <input
                class="input"
                aria-label={`Find in ${title() || 'atoms'}`}
                placeholder={`Find in ${title() || 'atoms'}…`}
                value={query().text ?? ''}
                onInput={event => {
                  setSearch(event.currentTarget.value);
                  updateQuery({ ...query(), text: event.currentTarget.value.trim() || null, offset: 0 });
                }}
              />
            </label>
            <Button
              class="bordered"
              aria-label="Table options"
              aria-haspopup="dialog"
              aria-expanded={!!querySheet()}
              onClick={event => setQuerySheet(event.currentTarget)}
            >
              <Icon name="query" />
              <span class="table-query-label">Query</span> <span class="table-query-count">{queryParts()}</span>
            </Button>
          </div>
        </Show>
        <Show when={definitions() && missingFields().length}>
          <MissingFields
            fields={missingFields()}
            busy={savingView()}
            onRemove={id => {
              void removeMissingField(id).catch(message);
            }}
          />
        </Show>
        <div class="table-scroll-frame">
          <div
            ref={scroll}
            class="table-scroll"
            onScroll={() => {
              cancelAnimationFrame(scrollReport);
              scrollReport = requestAnimationFrame(() => {
                reportView();
                measureEdge();
              });
            }}
          >
            <ViewBody
              neighbour={props.neighbour}
              query={query()}
              result={result() ?? { fields: fields(), columns: [], rows: [], total: 0 }}
              workshop={props.workshop}
              onOpen={props.onOpen}
              onQueryChange={updateQuery}
              onEdited={doc => {
                history.push({ kind: 'cell', doc, rowId: null, fieldId: null });
                undone.length = 0;
                setViewUndo(false);
                setRowUndo(false);
              }}
              onUndo={redo => {
                void replayCell(redo).catch(message);
              }}
              table={() => (
                <TableGrid
                  neighbour={props.neighbour}
                  gridRef={element => {
                    grid = element;
                  }}
                  rows={groupedRows()}
                  columns={visibleColumns()}
                  workshop={props.workshop}
                  field={fieldById}
                  fieldName={fieldName}
                  columnWidth={columnWidth}
                  selected={selectedRow()}
                  focused={focused()}
                  tagged={members().taggedGroup}
                  grouped={!!query().group}
                  onFocus={(row, fieldId) => {
                    setFocused({ rowId: row.block.block.id, fieldId });
                    setSelectedRow(row.block.block.id);
                  }}
                  onOpen={openRow}
                  onRowMenu={rowKind() ? rowMenu : undefined}
                  editingTitle={renaming()?.row.block.block.id}
                  onGroup={toggleGroup}
                  onHeader={columnMenu}
                  onResize={resizeColumn}
                  onMove={(from, to) => moveColumn(from, 1, to)}
                  onClickCell={(row, field, anchor) => {
                    if (field.kind === 'checkbox') startEdit(row, field, anchor);
                  }}
                  onEdit={(row, field, anchor) => {
                    if (field.kind !== 'checkbox') startEdit(row, field, anchor);
                  }}
                  title={renderTitle}
                  cell={renderCell}
                  cardFields={phoneFields}
                  cardCell={renderCardCell}
                  refs={showRefs()}
                  refsHeading={`Derived from ${sourceField()?.name ?? 'Source'}`}
                  reference={renderRefs}
                  phone={phone()}
                  onRowPress={phone() && rowKind() ? rowContext : undefined}
                />
              )}
            />
            <Show when={!loading() && !error() && !missingFields().length && !members().rows.length}>
              <div class="table-empty">
                <p>
                  {query().filters.length ||
                  query().text ||
                  query().links?.length ||
                  query().from?.length ||
                  query().cites?.length
                    ? `No ${rowNoun()} match ${[...query().filters.map(filter => filterLabel(filter, pickerFields(), props.workshop, query().field_names)), ...(query().text ? [`“${query().text}”`] : []), ...(['links', 'from', 'cites'] as const).flatMap(key => (query()[key]?.length ? [key] : []))].join(', ')}.`
                    : `No ${rowNoun()} yet.`}
                </p>
                <Show
                  when={
                    query().filters.length ||
                    query().text ||
                    query().links?.length ||
                    query().from?.length ||
                    query().cites?.length
                  }
                >
                  <Button
                    class="bordered"
                    onClick={() => {
                      setSearch('');
                      updateQuery({ ...query(), filters: [], text: null, links: [], from: [], cites: [] });
                    }}
                  >
                    Clear filters
                  </Button>
                </Show>
              </div>
            </Show>
          </div>
          <Show when={edge().hidden}>
            <div class="table-more-right" style={{ height: `${edge().height}px` }}>
              <Button
                class="table-more-columns"
                label={`Scroll to ${edge().hidden} more ${edge().hidden === 1 ? 'column' : 'columns'}`}
                onClick={showMoreColumns}
              >
                +{edge().hidden} <Icon name="right" />
              </Button>
            </div>
          </Show>
        </div>
        <footer
          class="table-footer"
          classList={{
            'table-footer-action':
              !!error() ||
              !!deleted() ||
              viewUndo() ||
              rowUndo() ||
              !!rowNotice() ||
              canAppend() ||
              !!missingFields().length,
          }}
          role="status"
        >
          <Show
            when={deleted()}
            fallback={
              <>
                <span>
                  {loading()
                    ? 'Loading…'
                    : error() ||
                      (missingFields().length
                        ? 'Results paused; remove the missing field or undo its deletion.'
                        : `${(result()?.rows.length ?? 0).toLocaleString()} of ${countLabel(result()?.total ?? 0)}`)}
                </span>
                <Show when={!loading() && canAppend()}>
                  <span aria-hidden="true">·</span>
                  <Button
                    class="table-show-more"
                    disabled={appending()}
                    aria-busy={appending()}
                    onClick={() => {
                      void appendRows();
                    }}
                  >
                    Show {pageSize().toLocaleString()} more
                  </Button>
                </Show>
                <Show when={rowUndo()}>
                  <span>Row deleted ·</span>
                  <Button
                    disabled={replaying()}
                    onClick={() => {
                      setRowUndo(false);
                      void replayCell(false).catch(message);
                    }}
                  >
                    Undo
                  </Button>
                </Show>
                <Show when={rowNotice()}>
                  {note => (
                    <>
                      <span>
                        · {note().title}
                        {result()?.rows.some(row => row.block.block.id === note().id)
                          ? ' is in this table.'
                          : ' was filed under this tag but does not match the current view.'}
                      </span>
                      <Button onClick={event => props.onOpen({ kind: 'page', pageId: note().id }, opensBeside(event))}>
                        Open atom
                      </Button>
                      <Button label="Dismiss row notice" onClick={() => setRowNotice(undefined)}>
                        ×
                      </Button>
                    </>
                  )}
                </Show>
                <Show when={viewUndo()}>
                  <span>View saved ·</span>
                  <Button
                    disabled={replaying()}
                    onClick={() => {
                      void replayCell(false).catch(message);
                    }}
                  >
                    Undo
                  </Button>
                </Show>
              </>
            }
          >
            View deleted ·{' '}
            <Button
              onClick={() => {
                void undoDelete().catch(message);
              }}
            >
              Undo
            </Button>
          </Show>
        </footer>
      </div>
      <Show when={narrow() && querySheet()}>
        {anchor => (
          <TableQuerySheet
            anchor={anchor() as HTMLElement}
            phone={phone()}
            hasPopup={!!popup()}
            saved={saved()}
            title={title()}
            changed={changed()}
            savingView={savingView()}
            toolbar={queryToolbar()}
            phoneOptions={phoneOptions()}
            popups={popups()}
            onClearPopup={() => setPopup(null)}
            onDismissSheet={() => setQuerySheet(null)}
            onRevert={switchView}
            onSaveChanges={() => {
              void saveChanges().catch(message);
            }}
          />
        )}
      </Show>
      <Show when={!(phone() && querySheet())}>{popups()}</Show>
    </div>
  );
}
