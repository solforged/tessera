import { createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from 'solid-js';
import type { Accessor, Setter } from 'solid-js';
import type { FieldDefinition, Fields, Filter, NoteIndex, Query, QueryResult, SortKey, Type, View } from '../api/types';
import type { TableViewState } from '../core/contract';
import type { WorkshopClient } from '../document/contract';
import { fieldLabel } from '../fields/kinds';
import { autoPlural } from '../fields/presentation';
import { missingFilter, requiredIds } from '../fields/required';
import { censusNoun, kindLabel, kindPlural, kindTally } from '../notes/kinds';
import { plainText } from '../outline/names';
import { taskFieldName } from '../tasks/task-fields';
import type { MenuItem } from '../ui/Menu';
import { attributeDefinitions, sourceName } from './attributes';
import {
  copyQuery,
  filterLabel,
  missingQueryFields,
  noteTableQuery,
  queriesEqual,
  sortLabel,
  untouchedQuery,
} from './query';
import { defaultEntityColumns, registerMembers, rowSources, sourceDefinition } from './register';

const membersLabel = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'member' : 'members'}`;

export interface TableQueryStateOptions {
  workshop: WorkshopClient;
  initialQuery: Query;
  targetQuery: Accessor<Query>;
  targetViewId: Accessor<string | null | undefined>;
  saved: Accessor<View | undefined>;
  viewScroll: Accessor<Pick<TableViewState, 'scroll' | 'horizontalScroll'>>;
  scroll: () => HTMLDivElement | undefined;
  scrollHost: () => HTMLDivElement | undefined;
  showResult: (next: QueryResult) => void;
  setError: Setter<string>;
  message: (reason: unknown) => void;
  onUpdateQuery: (next: Query) => void;
  onReportView: (value?: Query) => void;
  onMeasureEdge: () => void;
}

export function createTableQueryState(options: TableQueryStateOptions) {
  const [query, setQuery] = createSignal(noteTableQuery(options.initialQuery));
  const [search, setSearch] = createSignal(query().text ?? '');
  const [result, setResult] = createSignal<QueryResult>();
  const [definitions, setDefinitions] = createSignal<Fields>();
  const [type, setType] = createSignal<Type>();
  const [indexTotal, setIndexTotal] = createSignal<number>();
  const [noteIndex, setNoteIndex] = createSignal<NoteIndex>();
  const [loading, setLoading] = createSignal(true);
  const [appending, setAppending] = createSignal(false);
  const [columnSearch, setColumnSearch] = createSignal('');
  const [initialColumns, setInitialColumns] = createSignal<string[]>();

  const pageSize = () => query().limit ?? 500;
  const canAppend = createMemo(() => pageSize() > 0 && !!result() && result()!.rows.length < result()!.total);
  let appendController: AbortController | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let restoredScroll = false;

  onCleanup(() => {
    clearTimeout(searchTimer);
  });

  const clearSearchTimer = () => clearTimeout(searchTimer);
  const scheduleSearch = (text: string) => {
    setSearch(text);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => options.onUpdateQuery({ ...query(), text: text.trim() ? text : null }), 150);
  };

  const fields = createMemo(() => {
    const combined = new Map<string, FieldDefinition>((definitions()?.fields ?? []).map(field => [field.id, field]));
    for (const field of result()?.fields ?? []) if (!combined.has(field.id)) combined.set(field.id, field);
    return [...combined.values()];
  });
  const attributes = createMemo(() =>
    attributeDefinitions(query().source).map(field =>
      field.id === '@kind'
        ? { ...field, options: (noteIndex()?.kinds ?? []).map(kind => ({ id: kind.key, text: kind.name })) }
        : field,
    ),
  );
  const pickerFields = createMemo(() => [
    ...attributes().filter(field => field.id !== '@due'),
    ...fields().filter(field => query().source !== 'tasks' || !taskFieldName(field)),
  ]);
  const fieldGroups = createMemo(() => {
    const template = new Set(query().type ? (type()?.fields ?? []) : []);
    const own = fields()
      .filter(field => template.has(field.id) && (query().source !== 'tasks' || !taskFieldName(field)))
      .sort((a, b) => [...template].indexOf(a.id) - [...template].indexOf(b.id));
    return [
      { section: 'Tag template', fields: own },
      { section: 'Built in', fields: attributes().filter(field => field.id !== '@due') },
      {
        section: own.length ? 'Other fields' : 'Fields',
        fields: fields().filter(
          field => !template.has(field.id) && (query().source !== 'tasks' || !taskFieldName(field)),
        ),
      },
    ].filter(group => group.fields.length);
  });
  const fieldItems = (item: (field: FieldDefinition) => Omit<MenuItem, 'label' | 'section'>, omit?: string) =>
    fieldGroups().flatMap(group =>
      group.fields
        .filter(field => field.id !== omit)
        .map((field): MenuItem => ({ label: fieldLabel(field), section: group.section, ...item(field) })),
    );
  const columnChoices = createMemo(() =>
    pickerFields().filter(
      field =>
        field.id !== '@title' &&
        (field.id !== '@due' || query().columns?.some(column => column.key === '@due')) &&
        fieldLabel(field).toLocaleLowerCase().includes(columnSearch().toLocaleLowerCase()),
    ),
  );
  const fieldById = (id: string) =>
    pickerFields().find(field => field.id === id) ??
    attributes().find(field => field.id === id) ??
    fields().find(field => field.id === id);
  const definedFieldName = (id: string) => {
    const field = fieldById(id);
    return field ? fieldLabel(field) : undefined;
  };
  const fieldName = (id: string) => definedFieldName(id) ?? query().field_names?.[id] ?? 'Missing field';
  const missingFields = createMemo(() => (definitions() ? missingQueryFields(query(), definitions()!.fields) : []));
  const labelSort = (key: SortKey) => sortLabel(key, pickerFields(), query().field_names);
  const labelFilter = (filter: Filter) =>
    plainText(filterLabel(filter, pickerFields(), options.workshop, query().field_names), id =>
      options.workshop.lookup(id),
    );
  const members = createMemo(() => registerMembers(result()?.rows ?? []));
  const groupedRows = createMemo(() => {
    const rows = members().rows;
    const groups = query().group ? (result()?.groups ?? []) : [];
    if (!groups.length)
      return rows.map(row => ({
        row,
        group: undefined as NonNullable<QueryResult['groups']>[number] | undefined,
        hidden: false,
      }));
    const byId = new Map(rows.map(row => [row.block.block.id, row]));
    return groups.flatMap(group =>
      group.row_ids.flatMap((id, index) => {
        const row = byId.get(id);
        return row
          ? [
              {
                row,
                group: index === 0 ? group : undefined,
                hidden: query().group?.collapsed?.includes(group.key) ?? false,
              },
            ]
          : [];
      }),
    );
  });
  const navigableRows = createMemo(() => [
    ...new Map(
      groupedRows()
        .filter(entry => !entry.hidden)
        .map(entry => [entry.row.block.block.id, entry.row]),
    ).values(),
  ]);
  const sourceField = createMemo(() => sourceDefinition(result()?.columns ?? [], fields()));
  const sourcesByRow = createMemo(
    () => new Map((result()?.rows ?? []).map(row => [row.block.block.id, rowSources(row, sourceField())])),
  );
  const typeKind = () =>
    query().note_kind || query().type
      ? noteIndex()?.kinds.find(kind =>
          query().note_kind ? kind.key === query().note_kind : kind.type_id === query().type,
        )
      : undefined;
  const rowKind = () => {
    if (query().source === 'questions' && !query().type)
      return { key: 'question', name: 'Question', plural: 'Questions', icon: null, type_id: null };
    const current = type();
    if (!query().type || !current || (query().source && query().source !== 'notes')) return undefined;
    return (
      typeKind() ?? {
        key: `type:${current.page.id}`,
        name: current.page.text,
        plural: current.plural ?? autoPlural(current.page.text),
        icon: current.icon,
        type_id: current.page.id,
      }
    );
  };
  const atDefault = createMemo(() => {
    const current = query();
    const recipe = initialColumns();
    const recipeOnly =
      !!recipe &&
      !!current.columns &&
      current.columns.every(column => column.key === '@title' || column.width === undefined) &&
      current.columns
        .filter(column => column.key !== '@title')
        .map(column => column.key)
        .join('\n') === recipe.join('\n');
    return queriesEqual(
      recipeOnly ? { ...current, columns: undefined } : current,
      noteTableQuery(untouchedQuery(current)),
    );
  });
  const changed = () => !!options.saved() && !queriesEqual(query(), options.saved()!.query);
  const title = () => {
    const kind = typeKind();
    return kind
      ? kindLabel(kind)
      : (type()?.plural ??
          (query().type
            ? autoPlural(options.workshop.lookup(query().type!)()?.text ?? '')
            : query().source
              ? sourceName(query().source)
              : ''));
  };
  const kindTable = () => !!query().note_kind || (!!query().type && (!query().source || query().source === 'notes'));
  const kindKey = () => query().note_kind ?? typeKind()?.key ?? `type:${query().type}`;
  const purposeShown = () => !kindTable() || !!options.targetViewId() || !!query().purpose;
  const countLabel = (count: number) => (kindTable() ? kindTally(count, kindKey()) : membersLabel(count));
  const rowNoun = () => {
    const kind = kindTable() ? typeKind() : undefined;
    return kind ? kindPlural(kind) : sourceName(query().source).toLocaleLowerCase();
  };
  const queryParts = createMemo(
    () =>
      query().filters.length +
      query().sort.length +
      (query().group ? 1 : 0) +
      (query().text ? 1 : 0) +
      (query().source && query().source !== 'notes' ? 1 : 0) +
      (query().links?.length ?? 0) +
      (query().from?.length ?? 0) +
      (query().cites?.length ?? 0),
  );
  const summary = createMemo(() => {
    const count = result()?.total ?? 0;
    const plural = typeKind()?.plural ?? (title() || 'atoms');
    const noun =
      count === 1
        ? (typeKind()?.name ??
          type()?.page.text ??
          (query().type ? (options.workshop.lookup(query().type!)()?.text ?? plural) : plural.slice(0, -1)))
        : plural;
    return [
      `${canAppend() ? `${(result()?.rows.length ?? 0).toLocaleString()} of ` : ''}${count.toLocaleString()} ${noun.toLocaleLowerCase()}`,
      ...(query().text ? [`“${query().text}”`] : []),
      ...(['links', 'from', 'cites'] as const).flatMap(key =>
        (query()[key] ?? []).map(id => `${key} ${options.workshop.lookup(id)()?.text ?? 'Loading…'}`),
      ),
      ...query().filters.map(labelFilter),
      ...(query().sort.length ? [`sorted by ${query().sort.map(labelSort).join(', ')}`] : []),
      ...(query().group ? [`by ${fieldName(query().group!.key)}`] : []),
    ].join(' · ');
  });
  const census = () => {
    const total = result()?.total;
    return total === undefined
      ? undefined
      : { total, noun: kindTable() ? censusNoun(total, kindKey(), typeKind()) : total === 1 ? 'member' : 'members' };
  };

  const required = createMemo(() => requiredIds(type()));
  const [gaps] = createResource(
    () => (!loading() && type()?.required?.some(field => field.missing > 0) ? ([query(), type()!] as const) : false),
    ([value, current]) =>
      Promise.all(
        current.required
          .filter(field => field.missing > 0)
          .map(async field => {
            const filters = [
              ...value.filters.filter(filter => !(filter.field === field.field_id && filter.op === 'empty')),
              missingFilter(field.field_id),
            ];
            return {
              field_id: field.field_id,
              missing: (await options.workshop.api.query({ ...value, filters, offset: 0, limit: 0 })).total,
            };
          }),
      ),
  );

  const showMissing = (field: string) => {
    const filters = query().filters.filter(filter => !(filter.field === field && filter.op === 'empty'));
    options.onUpdateQuery({ ...query(), filters: [...filters, missingFilter(field)], offset: 0 });
  };

  const refreshCells = async () =>
    options.showResult(
      await options.workshop.api.query({
        ...copyQuery(query()),
        offset: 0,
        limit: Math.max(pageSize(), result()?.rows.length ?? 0),
      }),
    );

  let observedSaved: View | undefined;
  createEffect(() => {
    const next = options.saved();
    if (!next) return;
    untrack(() => {
      const previous = noteTableQuery(observedSaved?.query ?? options.targetQuery());
      if (queriesEqual(query(), previous)) {
        options.onUpdateQuery(noteTableQuery(next.query));
        setSearch(next.query.text ?? '');
      }
      observedSaved = next;
    });
  });

  let firstQuery = true;
  createEffect(() => {
    const value = copyQuery(query());
    options.workshop.changeSequence();
    const controller = new AbortController();
    appendController?.abort();
    setAppending(false);
    setLoading(true);
    const delay = firstQuery ? 0 : 150;
    firstQuery = false;
    const timer = setTimeout(() => {
      void (async () => {
        const allFields = await options.workshop.api.fields(controller.signal);
        if (controller.signal.aborted) return;
        setDefinitions(allFields);
        if (missingQueryFields(value, allFields.fields).length) {
          setResult(undefined);
          options.setError('');
          setLoading(false);
          return;
        }
        const [rows, pageType, index] = await Promise.all([
          options.workshop.api.query({ ...value, offset: 0 }, controller.signal),
          value.type ? options.workshop.api.type(value.type, controller.signal) : Promise.resolve(undefined),
          options.workshop.api.noteIndex(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setType(pageType);
        setNoteIndex(index);
        const kind =
          value.note_kind ??
          (value.type ? (index.kinds.find(kind => kind.type_id === value.type)?.key ?? `type:${value.type}`) : null);
        if (!kind) setIndexTotal(undefined);
        else
          void options.workshop.api
            .query(
              { ...value, note_kind: kind, note_view: { layout: 'index', grouping: 'letter' }, offset: 0, limit: 0 },
              controller.signal,
            )
            .then(
              notes => {
                if (!controller.signal.aborted) setIndexTotal(notes.total);
              },
              () => {},
            );
        if (
          value.source &&
          !value.columns &&
          !value.type &&
          !value.note_kind &&
          !options.targetViewId() &&
          !initialColumns()
        ) {
          setInitialColumns(defaultEntityColumns(value.source, rows));
          options.onReportView(value);
        }
        options.showResult(rows);
        options.setError('');
        setLoading(false);
        if (!restoredScroll) {
          restoredScroll = true;
          requestAnimationFrame(() => {
            const scrollEl = options.scroll(),
              hostEl = options.scrollHost(),
              savedScroll = options.viewScroll();
            if (scrollEl && hostEl) {
              hostEl.scrollTop = savedScroll.scroll;
              scrollEl.scrollLeft = savedScroll.horizontalScroll ?? 0;
            }
          });
        }
      })().catch(reason => {
        if (!controller.signal.aborted) {
          options.message(reason);
          setLoading(false);
        }
      });
    }, delay);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
      appendController?.abort();
    });
  });

  const appendRows = async () => {
    const current = result();
    if (!current || loading() || appending() || !canAppend()) return;
    const controller = new AbortController();
    appendController = controller;
    setAppending(true);
    options.setError('');
    try {
      const next = await options.workshop.api.query(
        { ...copyQuery(query()), limit: pageSize(), offset: current.rows.length },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const host = options.scrollHost(),
        scrollEl = options.scroll();
      if (!host || !scrollEl) return;
      const top = host.scrollTop;
      const left = scrollEl.scrollLeft;
      const viewport = host.getBoundingClientRect();
      const anchor = [...scrollEl.querySelectorAll<HTMLElement>('[data-block-id]')].find(row => {
        const bounds = row.getBoundingClientRect();
        return bounds.width > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      const anchorTop = anchor?.getBoundingClientRect().top;
      const groups = new Map(
        (current.groups ?? []).map(group => [group.key, { ...group, row_ids: [...group.row_ids] }]),
      );
      for (const group of next.groups ?? []) {
        const previous = groups.get(group.key);
        groups.set(
          group.key,
          previous
            ? {
                ...group,
                row_ids: [...previous.row_ids, ...group.row_ids.filter(id => !previous.row_ids.includes(id))],
              }
            : group,
        );
      }
      setResult({ ...next, rows: [...current.rows, ...next.rows], groups: [...groups.values()] });
      requestAnimationFrame(() => {
        if (controller.signal.aborted) return;
        host.scrollTop = top + (anchor && anchorTop !== undefined ? anchor.getBoundingClientRect().top - anchorTop : 0);
        scrollEl.scrollLeft = left;
        options.onReportView();
        options.onMeasureEdge();
      });
    } catch (reason) {
      if (!controller.signal.aborted) options.message(reason);
    } finally {
      if (!controller.signal.aborted) setAppending(false);
    }
  };

  return {
    query,
    setQuery,
    search,
    setSearch,
    scheduleSearch,
    clearSearchTimer,
    result,
    setResult,
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
  };
}
