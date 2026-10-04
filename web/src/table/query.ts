import type { FieldDefinition, Filter, FilterOp, Query, SortKey } from '../api/types';
import { parseCardText } from '../review/card-text';

export const filterLabels: Record<FilterOp, string> = {
  is: 'is', is_not: 'is not', contains: 'contains', gt: '>', gte: '≥', lt: '<', lte: '≤', present: 'is present', set: 'is set', empty: 'is empty',
};
export function typeQuery(type: string | null): Query {
  return { type, text: null, filters: [], sort: [], limit: null };
}
export function copyQuery(query: Query): Query {
  return { ...query, filters: query.filters.map(filter => ({ ...filter })), sort: query.sort.map(key => ({ ...key })) };
}
export function queriesEqual(left: Query, right: Query): boolean {
  return left.type === right.type && left.text === right.text && left.limit === right.limit
    && left.filters.length === right.filters.length && left.filters.every((filter, index) => {
      const other = right.filters[index]!;
      return filter.field === other.field && filter.op === other.op && filter.value === other.value;
    })
    && left.sort.length === right.sort.length && left.sort.every((key, index) => sameSort(key, right.sort[index]!) && key.direction === right.sort[index]!.direction);
}
function sameSort(left: Pick<SortKey, 'by' | 'field'>, right: Pick<SortKey, 'by' | 'field'>): boolean {
  return left.by === right.by && left.field === right.field;
}
export function sortLabel(key: SortKey, fields: readonly FieldDefinition[]): string {
  const name = key.by === 'field' ? fields.find(field => field.id === key.field)?.name ?? key.field ?? ''
    : { title: 'Title', created: 'Created', updated: 'Updated' }[key.by];
  return `${name} ${key.direction === 'asc' ? '↑' : '↓'}`;
}
export function filterLabel(filter: Filter, fields: readonly FieldDefinition[]): string {
  const name = fields.find(field => field.id === filter.field)?.name ?? filter.field;
  return `${name} ${filterLabels[filter.op]}${filter.op === 'present' || filter.op === 'set' || filter.op === 'empty' ? '' : ` ${filter.value ?? ''}`}`;
}
/** Move this key to the front, flipping its direction when chosen again. */
export function chooseSort(query: Query, key: Pick<SortKey, 'by' | 'field'>, direction?: SortKey['direction']): Query {
  const existing = query.sort.find(candidate => sameSort(candidate, key));
  return { ...query, sort: [{ ...key, direction: direction ?? (existing?.direction === 'asc' ? 'desc' : 'asc') }, ...query.sort.filter(candidate => !sameSort(candidate, key))] };
}
export function removeSort(query: Query, index: number): Query {
  return { ...query, sort: query.sort.filter((_, position) => position !== index) };
}
export function addFilter(query: Query, filter: Filter): Query {
  return { ...query, filters: [...query.filters, { ...filter, value: filter.op === 'present' || filter.op === 'set' || filter.op === 'empty' ? null : filter.value }] };
}
export function removeFilter(query: Query, index: number): Query {
  return { ...query, filters: query.filters.filter((_, position) => position !== index) };
}
export function matchFieldEntry(text: string): { name: string; value: string } | null {
  const match = /^([^\\`\[\]#:]{1,60}?)::\s?(.*)$/.exec(text);
  if (!match || !match[1]!.trim()) return null;
  const name = match[1]!.trim();
  const prefix = parseCardText(name);
  if (prefix.cards.length || prefix.problems.length) return null;
  return { name, value: match[2]! };
}
export function fieldEntryText(fieldId: string): string { return `[[${fieldId}]]`; }
export function fieldEntryId(text: string): string | null {
  return /^\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*$/.exec(text)?.[1] ?? null;
}
