import { For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { FieldDefinition, QueryRow } from '../api/types';
import { createGridRows } from './register';
import type { GroupedRow } from './register';
import type { NotebookClient } from '../document/contract';
import { BlockText } from '../outline/BlockText';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import './table.css';

export interface TableGridProps {
  rows: GroupedRow[]; columns: string[]; notebook: NotebookClient;
  field(id: string): FieldDefinition | undefined; fieldName(id: string): string;
  columnWidth(id: string): string; gridRef?(element: HTMLTableElement): void;
  selected?: string | null; focused?: { rowId: string | null; fieldId: string | null };
  tagged?: { rowId: string; count: number } | null; grouped?: boolean;
  onFocus?(row: QueryRow, field: string | null): void;
  onOpen(row: QueryRow, beside: boolean): void;
  onGroup?(key: string): void; onHeader?(anchor: HTMLElement, field?: FieldDefinition): void;
  onResize?(event: PointerEvent, id: string): void; onMove?(from: string, to: string): void;
  onClickCell?(row: QueryRow, field: FieldDefinition, anchor: HTMLElement): void;
  onEdit?(row: QueryRow, field: FieldDefinition, anchor: HTMLElement): void;
  title(row: QueryRow): JSX.Element; cell(row: QueryRow, field: string): JSX.Element;
  cardFields(row: QueryRow): FieldDefinition[]; cardCell(row: QueryRow, field: FieldDefinition): JSX.Element;
  refs?: boolean; refsHeading?: string; reference?(row: QueryRow, phone: boolean): JSX.Element;
}

/** One grid and phone-card projection for managed tables and embedded query results. */
export function TableGrid(props: TableGridProps) {
  let dragged: string | undefined;
  const reconcileRows = createGridRows();
  const rows = createMemo(() => reconcileRows(props.rows));
  return <>
    <table ref={props.gridRef} class="type-table table-grid" role="grid"><colgroup><col style={{ width: 'var(--table-title-width)' }} /><For each={props.columns}>{id => <col style={{ width: props.columnWidth(id) }} />}</For><Show when={props.refs}><col style={{ width: 'var(--table-refs-width)' }} /></Show></colgroup>
      <thead><tr><th scope="col" class="table-title-column"><Button aria-haspopup={props.onHeader ? 'menu' : undefined} onClick={event => props.onHeader?.(event.currentTarget)}>Title</Button><Show when={props.onResize}><span class="table-resize" role="separator" aria-label="Resize Title" aria-orientation="vertical" onPointerDown={event => props.onResize?.(event, '@title')} /></Show></th>
        <For each={props.columns}>{id => <th scope="col" draggable={!!props.onMove} onDragStart={event => { dragged = id; event.dataTransfer?.setData('text/plain', id); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (dragged) props.onMove?.(dragged, id); dragged = undefined; }}><Button aria-haspopup={props.onHeader ? 'menu' : undefined} onClick={event => props.onHeader?.(event.currentTarget, props.field(id))}>{props.fieldName(id)}</Button><Show when={props.onResize}><span class="table-resize" role="separator" aria-label={`Resize ${props.fieldName(id)}`} aria-orientation="vertical" onPointerDown={event => props.onResize?.(event, id)} /></Show></th>}</For>
        <Show when={props.refs}><th scope="col" class="table-refs" title={props.refsHeading}>Refs</th></Show>
      </tr></thead><tbody><For each={rows()}>{entry => { const row = entry.row; return <>
        <Show when={entry.group}>{group => <tr class="table-member-group"><th colSpan={1 + props.columns.length + (props.refs ? 1 : 0)}><Button aria-expanded={!entry.hidden} onClick={() => props.onGroup?.(group().key)}><Icon name={entry.hidden ? 'right' : 'down'} />{group().title}<span class="table-popup-count">{group().count}</span></Button></th></tr>}</Show>
        <Show when={!props.grouped && props.tagged?.rowId === row.block.block.id}><tr class="table-member-group"><th colSpan={1 + props.columns.length + (props.refs ? 1 : 0)}><span class="table-member-group-label">Tagged blocks <span>{props.tagged?.count}</span></span></th></tr></Show>
        <tr hidden={entry.hidden} data-block-id={row.block.block.id} classList={{ selected: props.selected === row.block.block.id }} onClick={event => { if (window.matchMedia('(pointer: coarse) and (min-width: 900px)').matches && !(event.target as HTMLElement).closest('button, input, textarea, a, .cm-editor')) props.onOpen(row, true); }}>
          <td class="table-title-column table-cell" tabIndex={props.focused?.rowId === row.block.block.id && props.focused.fieldId === null ? 0 : -1} onFocus={() => props.onFocus?.(row, null)} onClick={event => { event.stopPropagation(); props.onOpen(row, event.shiftKey); }}>{props.title(row)}<Show when={row.block.block.kind === 'block'}><div class="table-page-title">in {row.block.page.text}</div></Show><Button class="table-row-beside" label={row.block.block.kind === 'block' ? 'Open block beside' : 'Open note beside'} onClick={event => { event.stopPropagation(); props.onOpen(row, true); }}>↗</Button></td>
          <For each={props.columns}>{id => <td class={`table-cell table-kind-${props.field(id)?.kind ?? 'text'}`} data-field-id={id} tabIndex={props.focused?.rowId === row.block.block.id && props.focused.fieldId === id ? 0 : -1} onFocus={() => props.onFocus?.(row, id)} onClick={event => { event.stopPropagation(); if ((event.target as HTMLElement).closest('input, textarea, button, a, .cm-editor')) return; event.currentTarget.focus({ preventScroll: true }); const field = props.field(id); if (field) props.onClickCell?.(row, field, event.currentTarget); }} onDblClick={event => { event.stopPropagation(); const field = props.field(id); if (!(event.target as HTMLElement).closest('input, textarea, .cm-editor') && field) props.onEdit?.(row, field, event.currentTarget); }}>{props.cell(row, id)}</td>}</For>
          <Show when={props.refs}><td class="table-refs">{props.reference?.(row, false)}</td></Show>
        </tr></>; }}</For></tbody>
    </table>
    <div class="table-cards" role="list" aria-label="Members"><For each={rows()}>{entry => { const row = entry.row; return <>
      <Show when={entry.group}>{group => <div class="table-card-group"><Button aria-expanded={!entry.hidden} onClick={() => props.onGroup?.(group().key)}><Icon name={entry.hidden ? 'right' : 'down'} />{group().title}<span class="table-popup-count">{group().count}</span></Button></div>}</Show>
      <Show when={!props.grouped && props.tagged?.rowId === row.block.block.id}><div class="table-card-group" role="presentation"><span class="table-member-group-label">Tagged blocks <span>{props.tagged?.count}</span></span></div></Show>
      <article hidden={entry.hidden} class="table-card" data-block-id={row.block.block.id} classList={{ selected: props.selected === row.block.block.id }} role="listitem" onClick={event => { if (!(event.target as HTMLElement).closest('button, [role="button"], a, .cm-editor')) props.onOpen(row, event.shiftKey); }}>
        <Button class="table-card-title" onClick={event => props.onOpen(row, event.shiftKey)}><span class="table-card-text"><BlockText text={props.notebook.lookup(row.block.block.id)()?.text ?? row.block.block.text} notebook={props.notebook} interactive={false} cards /></span><span class="table-card-arrow" aria-hidden="true">›</span></Button><Show when={row.block.block.kind === 'block'}><div class="table-page-title">in {row.block.page.text}</div></Show>
        <div class="table-card-fields"><For each={props.cardFields(row)}>{field => props.cardCell(row, field)}</For><Show when={props.refs}>{props.reference?.(row, true)}</Show></div>
      </article></>; }}</For></div>
  </>;
}
