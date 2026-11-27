import { createMemo, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { FieldDefinition, Query, QueryResult } from '../api/types';
import { scrollBehavior } from '../core/motion';
import { columnEdge } from './edge';

export const titleWidthLimits = { min: 170, max: 340, default: 200 };
export const clampTitleWidth = (width: number | undefined) =>
  Number.isFinite(width)
    ? Math.max(titleWidthLimits.min, Math.min(titleWidthLimits.max, width!))
    : titleWidthLimits.default;
export const refsColumn = '$refs';

export interface ColumnResizeOptions {
  initialTitleWidth: number | undefined;
  initialHiddenFields: readonly string[] | undefined;
  query: Accessor<Query>;
  result: Accessor<QueryResult | undefined>;
  initialColumns: Accessor<string[] | undefined>;
  fieldById: (id: string) => FieldDefinition | undefined;
  sourceField: Accessor<FieldDefinition | undefined>;
  scroll: () => HTMLDivElement | undefined;
  grid: () => HTMLTableElement | undefined;
  onReportView: () => void;
  onUpdateQuery: (next: Query) => void;
}

export function createColumnResize(options: ColumnResizeOptions) {
  const [hiddenFields, setHiddenFields] = createSignal([...(options.initialHiddenFields ?? [])]);
  const [titleWidth, setTitleWidth] = createSignal(clampTitleWidth(options.initialTitleWidth));
  const [resizingWidths, setResizingWidths] = createSignal<Record<string, number>>({});
  const [edge, setEdge] = createSignal({ height: 0, hidden: 0 });

  const visibleColumns = createMemo(() =>
    options.query().columns
      ? options
          .query()
          .columns!.map(column => column.key)
          .filter(id => id !== '@title')
      : (options.initialColumns() ??
        (options.result()?.columns ?? []).filter(id => id !== '@title' && !hiddenFields().includes(id))),
  );

  const showRefs = () =>
    !!options.sourceField() &&
    visibleColumns().includes(options.sourceField()!.id) &&
    !hiddenFields().includes(refsColumn);

  const recipeColumns = () =>
    options.query().columns?.map(column => ({ ...column })) ?? [
      { key: '@title', width: titleWidth() },
      ...visibleColumns().map(key => ({ key, width: undefined as number | undefined })),
    ];

  const columnWidth = (id: string) => {
    const width = resizingWidths()[id] ?? options.query().columns?.find(column => column.key === id)?.width;
    if (width) return `${width}px`;
    const kind = options.fieldById(id)?.kind;
    return id === options.sourceField()?.id
      ? 'var(--table-source-width)'
      : kind === 'number' || kind === 'checkbox' || kind === 'choice' || id === '@project_progress'
        ? 'var(--table-narrow-width)'
        : kind === 'date'
          ? 'var(--table-compact-width)'
          : 'var(--table-field-width)';
  };

  const measureEdge = () => {
    const grid = options.grid(),
      scroll = options.scroll();
    if (!grid?.isConnected || !scroll || (options.query().layout ?? 'table') !== 'table') {
      setEdge({ hidden: 0, height: 0 });
      return;
    }
    setEdge(columnEdge(scroll, grid));
  };

  const showMoreColumns = () =>
    options.scroll()?.scrollBy({
      left: (options.scroll()?.clientWidth ?? 0) - titleWidth(),
      behavior: scrollBehavior(),
    });

  const showField = (id: string, visible: boolean) => {
    if (id === refsColumn) {
      setHiddenFields(values =>
        visible ? values.filter(value => value !== id) : values.includes(id) ? values : [...values, id],
      );
      options.onReportView();
      return;
    }
    const columns = recipeColumns();
    options.onUpdateQuery({
      ...options.query(),
      columns: visible
        ? columns.some(column => column.key === id)
          ? columns
          : [...columns, { key: id }]
        : columns.filter(column => column.key !== id),
    });
  };

  const moveColumn = (id: string, direction: -1 | 1, target?: string) => {
    const columns = recipeColumns();
    const index = columns.findIndex(column => column.key === id);
    const next = target ? columns.findIndex(column => column.key === target) : index + direction;
    if (index < 1 || next < 1 || next >= columns.length || index === next) return;
    columns.splice(next, 0, columns.splice(index, 1)[0]!);
    options.onUpdateQuery({ ...options.query(), columns });
  };

  const resizeColumn = (event: PointerEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    const start = event.clientX;
    const initial = handle.parentElement!.getBoundingClientRect().width;
    const columns = recipeColumns();
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      const width = Math.round(
        Math.max(id === '@title' ? 170 : 80, Math.min(id === '@title' ? 340 : 640, initial + next.clientX - start)),
      );
      if (id === '@title') setTitleWidth(width);
      else setResizingWidths({ [id]: width });
      columns.find(column => column.key === id)!.width = width;
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      options.onUpdateQuery({ ...options.query(), columns });
      setResizingWidths({});
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };

  return {
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
  };
}
