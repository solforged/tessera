import { listOpensBeside } from '../shell/beside';
import { For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { FieldDefinition, QueryRow, TaskState, TaskStatus } from '../api/types';
import { createGridRows } from './register';
import type { GroupedRow } from './register';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { plainText } from '../outline/names';
import { statusIcons, statusLabels, statuses } from '../tasks/TaskControls';
import { isFinished, taskFacts } from '../tasks/task-labels';
import { taskFieldName } from '../tasks/task-fields';
import { newTask } from '../tasks/quick-date';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import './table.css';

export interface TableGridProps {
  rows: GroupedRow[]; columns: string[]; notebook: NotebookClient; neighbour?: boolean;
  field(id: string): FieldDefinition | undefined; fieldName(id: string): string;
  columnWidth(id: string): string; gridRef?(element: HTMLTableElement): void;
  selected?: string | null; focused?: { rowId: string | null; fieldId: string | null };
  tagged?: { rowId: string; count: number } | null; grouped?: boolean;
  onFocus?(row: QueryRow, field: string | null): void;
  onOpen(row: QueryRow, beside: boolean): void;
  onRowMenu?(row: QueryRow, anchor: HTMLElement): void; editingTitle?: string;
  onGroup?(key: string): void; onHeader?(anchor: HTMLElement, field?: FieldDefinition): void;
  onResize?(event: PointerEvent, id: string): void; onMove?(from: string, to: string): void;
  onClickCell?(row: QueryRow, field: FieldDefinition, anchor: HTMLElement): void;
  onEdit?(row: QueryRow, field: FieldDefinition, anchor: HTMLElement): void;
  title(row: QueryRow, phone?: boolean): JSX.Element; cell(row: QueryRow, field: string): JSX.Element;
  cardFields(row: QueryRow): FieldDefinition[]; cardCell(row: QueryRow, field: FieldDefinition): JSX.Element;
  refs?: boolean; refsHeading?: string; reference?(row: QueryRow, phone: boolean): JSX.Element;
}

/** Query attributes carry the same task values as built-in field columns, even when those columns are hidden. */
function rowTask(row: QueryRow, field: TableGridProps['field']): TaskState | null {
  const carried = row as QueryRow & { task?: TaskState | null };
  if (carried.task !== undefined) return carried.task;
  const values = new Map<string, string>();
  for (const id of new Set([...Object.keys(row.values), ...Object.keys(row.attributes ?? {})])) {
    const definition = field(id);
    const name = definition ? taskFieldName(definition) : id.startsWith('@') ? id.slice(1) : undefined;
    if (name) values.set(name, (row.attributes?.[id]?.[0]?.text ?? row.values[id]?.[0]?.text ?? '').trim());
  }
  const status = values.get('status')?.toLowerCase();
  if (!status || !statuses.includes(status as TaskStatus)) return null;
  const task = newTask(status as TaskStatus);
  for (const name of ['scheduled', 'deadline'] as const) {
    const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/.exec(values.get(name) ?? '');
    if (match) { task[name] = match[1]!; task[`${name}_time`] = match[2] ?? null; }
  }
  const priority = values.get('priority')?.toLowerCase();
  if (priority === 'high' || priority === 'medium' || priority === 'low') task.priority = priority;
  return task;
}

/** One grid and phone-card projection for managed tables and embedded query results. */
export function TableGrid(props: TableGridProps) {
  let dragged: string | undefined;
  const reconcileRows = createGridRows();
  const rows = createMemo(() => reconcileRows(props.rows));
  const fieldName = (id: string) => {
    const field = props.field(id);
    return (field && taskFieldName(field)) || props.fieldName(id);
  };
  // A run of blocks from one page names it once, on the first; a group heading or the Tagged blocks rule starts a new run.
  const pageNamed = (index: number) => {
    const entry = rows()[index], previous = rows()[index - 1];
    return !entry || !previous || !!entry.group || (!props.grouped && props.tagged?.rowId === entry.row.block.block.id) || previous.row.block.block.kind !== 'block' || previous.row.block.page.id !== entry.row.block.page.id;
  };
  return <>
    <table ref={props.gridRef} class="type-table table-grid" role="grid"><colgroup><col style={{ width: 'var(--table-title-width)' }} /><For each={props.columns}>{id => <col style={{ width: props.columnWidth(id) }} />}</For><Show when={props.refs}><col style={{ width: 'var(--table-refs-width)' }} /></Show></colgroup>
      <thead><tr><th scope="col" class="table-title-column"><Button aria-haspopup={props.onHeader ? 'menu' : undefined} onClick={event => props.onHeader?.(event.currentTarget)}>Title</Button><Show when={props.onResize}><span class="table-resize" role="separator" aria-label="Resize Title" aria-orientation="vertical" onPointerDown={event => props.onResize?.(event, '@title')} /></Show></th>
        <For each={props.columns}>{id => <th scope="col" draggable={!!props.onMove} onDragStart={event => { dragged = id; event.dataTransfer?.setData('text/plain', id); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (dragged) props.onMove?.(dragged, id); dragged = undefined; }}><Button aria-haspopup={props.onHeader ? 'menu' : undefined} onClick={event => props.onHeader?.(event.currentTarget, props.field(id))}>{fieldName(id)}</Button><Show when={props.onResize}><span class="table-resize" role="separator" aria-label={`Resize ${fieldName(id)}`} aria-orientation="vertical" onPointerDown={event => props.onResize?.(event, id)} /></Show></th>}</For>
        <Show when={props.refs}><th scope="col" class="table-refs" title={props.refsHeading}>Refs</th></Show>
      </tr></thead><tbody><For each={rows()}>{(entry, index) => { const row = entry.row; return <>
        <Show when={entry.group}>{group => <tr class="table-member-group"><th colSpan={1 + props.columns.length + (props.refs ? 1 : 0)}><Button aria-expanded={!entry.hidden} onClick={() => props.onGroup?.(group().key)}><Icon name={entry.hidden ? 'right' : 'down'} />{group().title}<span class="table-popup-count">{group().count}</span></Button></th></tr>}</Show>
        <Show when={!props.grouped && props.tagged?.rowId === row.block.block.id}><tr class="table-member-group"><th colSpan={1 + props.columns.length + (props.refs ? 1 : 0)}><span class="table-member-group-label">Tagged atoms <span>{props.tagged?.count}</span></span></th></tr></Show>
        <tr hidden={entry.hidden} data-block-id={row.block.block.id} classList={{ selected: props.selected === row.block.block.id }} onClick={event => { if (window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches && !(event.target as HTMLElement).closest('button, input, textarea, a, .cm-editor')) props.onOpen(row, true); }}>
          <td class="table-title-column table-cell" classList={{ 'table-title-actions': !!props.onRowMenu }} tabIndex={props.focused?.rowId === row.block.block.id && props.focused.fieldId === null ? 0 : -1} onFocus={() => props.onFocus?.(row, null)} onClick={event => { event.stopPropagation(); if (!(event.target as HTMLElement).closest('input, textarea, button')) props.onOpen(row, listOpensBeside(event, !!props.neighbour)); }}>{props.title(row)}<Show when={row.block.block.kind === 'block' && pageNamed(index())}><div class="table-page-title">in {row.block.page.text}</div></Show><Button class="table-row-beside" label={row.block.block.kind === 'block' ? 'Open atom beside' : 'Open atom beside'} onClick={event => { event.stopPropagation(); props.onOpen(row, true); }}>↗</Button><Show when={props.onRowMenu}><Button class="table-row-menu" icon="more" label={`Actions for ${row.block.block.text}`} aria-haspopup="menu" onClick={event => { event.stopPropagation(); props.onRowMenu?.(row, event.currentTarget); }} /></Show></td>
          <For each={props.columns}>{id => <td class={`table-cell table-kind-${props.field(id)?.kind ?? 'text'}`} data-field-id={id} tabIndex={props.focused?.rowId === row.block.block.id && props.focused.fieldId === id ? 0 : -1} onFocus={() => props.onFocus?.(row, id)} onClick={event => { event.stopPropagation(); if ((event.target as HTMLElement).closest('input, textarea, button, a, .cm-editor')) return; event.currentTarget.focus({ preventScroll: true }); const field = props.field(id); if (field) props.onClickCell?.(row, field, event.currentTarget); }} onDblClick={event => { event.stopPropagation(); const field = props.field(id); if (!(event.target as HTMLElement).closest('input, textarea, .cm-editor') && field) props.onEdit?.(row, field, event.currentTarget); }}>{props.cell(row, id)}</td>}</For>
          <Show when={props.refs}><td class="table-refs">{props.reference?.(row, false)}</td></Show>
        </tr></>; }}</For></tbody>
    </table>
    <div class="table-cards" role="list" aria-label="Members"><For each={rows()}>{(entry, index) => { const row = entry.row;
      const task = createMemo(() => rowTask(row, props.field));
      const facts = createMemo(() => { const value = task(); const today = props.notebook.todayDate(); return value ? taskFacts(value, { date: today, today }) : []; });
      const summary = createMemo(() => task() ? [] : props.columns.slice(0, 2).flatMap(id => {
        const values = row.attributes?.[id] ?? row.values[id] ?? [];
        const text = values.map(value => plainText(value.text, target => props.notebook.lookup(target))).filter(Boolean).join(', ');
        return text ? [{ id, text }] : [];
      }));
      return <>
      <Show when={entry.group}>{group => <div class="table-card-group"><Button aria-expanded={!entry.hidden} onClick={() => props.onGroup?.(group().key)}><Icon name={entry.hidden ? 'right' : 'down'} />{group().title}<span class="table-popup-count">{group().count}</span></Button></div>}</Show>
      <Show when={!props.grouped && props.tagged?.rowId === row.block.block.id}><div class="table-card-group" role="presentation"><span class="table-member-group-label">Tagged atoms <span>{props.tagged?.count}</span></span></div></Show>
      <article hidden={entry.hidden} class="table-card" data-block-id={row.block.block.id} classList={{ selected: props.selected === row.block.block.id, 'table-card-finished': !!task() && isFinished(task()!) }} role="listitem" onClick={event => { if (!(event.target as HTMLElement).closest('button, [role="button"], input, textarea, a, .cm-editor')) props.onOpen(row, listOpensBeside(event, !!props.neighbour)); }}>
        <Show when={props.editingTitle === row.block.block.id} fallback={<Button class="table-card-title" onClick={event => props.onOpen(row, listOpensBeside(event, !!props.neighbour))}><Show when={task()?.status}>{status => <span class="table-card-status" role="img" aria-label={statusLabels[status()]} title={statusLabels[status()]}><Icon name={statusIcons[status()]} /></span>}</Show><span class="table-card-text"><BlockText text={props.notebook.lookup(row.block.block.id)()?.text ?? row.block.block.text} notebook={props.notebook} interactive={false} cards /></span><span class="table-card-arrow" aria-hidden="true">›</span></Button>}>{props.title(row, true)}</Show><Show when={row.block.block.kind === 'block' && pageNamed(index())}><div class="table-page-title">in {row.block.page.text}</div></Show>
        <Show when={facts().length || summary().length}><div class="table-card-facts"><For each={facts()}>{fact => <span title={fact.label} classList={{ 'table-card-late': !!fact.late, 'table-card-warning': !!fact.warning && !fact.late, 'table-card-priority-high': fact.priority === 'high' }}>{fact.text}</span>}</For><For each={summary()}>{value => <span title={fieldName(value.id)}>{value.text}</span>}</For></div></Show>
        <Show when={props.onRowMenu}><Button class="table-row-menu" icon="more" label={`Actions for ${row.block.block.text}`} aria-haspopup="menu" onClick={event => { event.stopPropagation(); props.onRowMenu?.(row, event.currentTarget); }} /></Show>
        <div class="table-card-fields"><For each={props.cardFields(row).filter(field => task() ? !['status', 'scheduled', 'deadline', 'priority'].includes(taskFieldName(field) ?? '') : !props.columns.slice(0, 2).includes(field.id))}>{field => props.cardCell(row, field)}</For><Show when={props.refs}>{props.reference?.(row, true)}</Show></div>
      </article></>; }}</For></div>
  </>;
}
