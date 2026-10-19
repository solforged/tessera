import { createStore, reconcile } from 'solid-js/store';
import type { SetStoreFunction } from 'solid-js/store';
import type { FieldDefinition, QueryGroup, QueryResult, QueryRow, QuerySource } from '../api/types';
import { textTokens } from '../document/text-tokens';
import { sourceText } from './sources';
import type { TableSource } from './sources';

export interface TableCell { rowId: string | null; fieldId: string | null }
export interface GroupedRow { row: QueryRow; group?: QueryGroup; hidden: boolean }

/** Refreshes reconcile data without replacing the row proxy that owns a live cell editor. */
export function createGridRows() {
  const cache = new Map<string, { state: GroupedRow; set: SetStoreFunction<GroupedRow> }>();
  return (rows: readonly GroupedRow[]): GroupedRow[] => {
    const retained = new Set<string>();
    let group = '';
    const next = rows.map(entry => {
      if (entry.group) group = entry.group.key;
      const key = `${group}:${entry.row.block.block.id}`;
      retained.add(key);
      let cached = cache.get(key);
      if (cached) {
        cached.set('row', reconcile(entry.row));
        cached.set('group', entry.group);
        cached.set('hidden', entry.hidden);
      } else {
        const [state, set] = createStore(entry);
        cached = { state, set }; cache.set(key, cached);
      }
      return cached.state;
    });
    for (const key of cache.keys()) if (!retained.has(key)) cache.delete(key);
    return next;
  };
}

/** Re-sorting retains the entity and field; only a removed row or hidden column changes the target. */
export function retainCell(cell: TableCell, rows: readonly QueryRow[], columns: readonly string[]): TableCell {
  const rowId = rows.some(row => row.block.block.id === cell.rowId) ? cell.rowId : rows[0]?.block.block.id ?? null;
  const fieldId = cell.fieldId && columns.includes(cell.fieldId) ? cell.fieldId : null;
  return rowId === cell.rowId && fieldId === cell.fieldId ? cell : { rowId, fieldId };
}

/** One register orders notes before blocks, with an apparatus divider only for mixed membership. */
export function registerMembers(rows: readonly QueryRow[]): { rows: QueryRow[]; taggedGroup: { rowId: string; count: number } | null } {
  const notes: QueryRow[] = []; const blocks: QueryRow[] = [];
  for (const row of rows) (row.block.block.kind === 'block' ? blocks : notes).push(row);
  return { rows: [...notes, ...blocks], taggedGroup: notes.length && blocks.length ? { rowId: blocks[0]!.block.block.id, count: blocks.length } : null };
}

const sourceColumns: Record<QuerySource, readonly string[]> = {
  notes: ['@kind'], questions: ['@state', '@readings', '@last_assessed', '@revisit'],
  positions: ['@holder', '@subject'], sources: ['@creator'], tasks: ['@status', '@scheduled', '@deadline', '@priority', '@project'], highlights: ['@source'],
};
/** New views start with at most six columns, including Title and a derived Refs column. */
export function defaultEntityColumns(source: QuerySource, result: QueryResult): string[] {
  const columns = [...sourceColumns[source]];
  const chosen = new Set(columns);
  for (const field of result.fields) {
    if (field.role === 'standfirst' && result.columns.includes(field.id) && !chosen.has(field.id)) {
      columns.push(field.id); chosen.add(field.id);
    }
  }
  if (result.rows.length) {
    const filled = new Map<string, number>();
    for (const row of result.rows) for (const [id, values] of Object.entries(row.values)) {
      if (values.some(value => value.text.trim())) filled.set(id, (filled.get(id) ?? 0) + 1);
    }
    const threshold = Math.ceil(result.rows.length / 4);
    for (const id of result.columns) if (!chosen.has(id) && (filled.get(id) ?? 0) >= threshold) {
      columns.push(id); chosen.add(id);
    }
  }
  const selected = columns.slice(0, 5);
  return sourceDefinition(selected, result.fields) ? selected.slice(0, 4) : selected;
}

/** Reveal a focused cell within the horizontal space not occupied by the sticky title. */
export function cellScrollLeft(current: number, left: number, right: number, frameLeft: number, frameRight: number, titleWidth: number): number {
  const start = frameLeft + titleWidth;
  if (left < start) return Math.max(0, current + left - start);
  if (right > frameRight) return current + Math.min(right - frameRight, left - start);
  return current;
}

/** Refs is a derived view of the authored Source field, not a stored field. */
export function sourceDefinition(columns: readonly string[], fields: readonly FieldDefinition[]): FieldDefinition | undefined {
  const candidates = fields.filter(field => columns.includes(field.id) && (field.kind === 'text' || field.kind === 'url'));
  return candidates.find(field => /^sources?$/i.test(field.name.trim())) ?? candidates.find(field => field.kind === 'url');
}

export function rowSources(row: QueryRow, field: FieldDefinition | undefined): TableSource[] {
  return field ? (row.values[field.id] ?? []).flatMap(value => sourceText(value.text).sources) : [];
}

/** Visibility also controls the two authored values prioritised on touch cards. */
export function cardFields(row: QueryRow, columns: readonly string[], fields: readonly FieldDefinition[], source: FieldDefinition | undefined): FieldDefinition[] {
  const candidates = columns.flatMap(id => {
    const field = fields.find(candidate => candidate.id === id);
    return field && (row.values[id] ?? []).some(value => value.text.trim()) ? [field] : [];
  });
  const choice = candidates.find(field => field.kind === 'choice');
  const reference = candidates.find(field => field.id === source?.id)
    ?? candidates.find(field => field.kind === 'instance' || (row.values[field.id] ?? []).some(value => textTokens(value.text).some(token => token.kind === 'reference')));
  const selected = [...new Set([choice, reference].filter((field): field is FieldDefinition => !!field))];
  for (const field of candidates) if (selected.length < 2 && !selected.includes(field)) selected.push(field);
  return selected;
}
