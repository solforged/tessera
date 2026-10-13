import type { FieldDefinition, FieldKind, Filter, FilterOp, Query, SortKey } from '../api/types';
import type { NotebookClient } from '../document/contract';
import { parseCardText } from '../review/card-text';

export const filterLabels: Record<FilterOp, string> = {
  is: 'is', is_not: 'is not', contains: 'contains', gt: '>', gte: '≥', lt: '<', lte: '≤', present: 'has the field', set: 'has a value', empty: 'is empty',
  overlaps: 'overlaps', before: 'before', after: 'after',
};
export function filterOperators(kind: FieldKind = 'text'): FilterOp[] {
  if (kind === 'checkbox') return ['is', 'is_not'];
  if (kind === 'choice' || kind === 'instance') return ['is', 'is_not', 'set', 'empty'];
  if (kind === 'span') return ['overlaps', 'before', 'after', 'is', 'is_not', 'present', 'set', 'empty'];
  return ['is', 'is_not', 'contains', ...(kind === 'number' || kind === 'date' ? ['gt', 'gte', 'lt', 'lte'] as const : []), 'present', 'set', 'empty'];
}
export function filterOperatorLabel(op: FilterOp, kind?: FieldKind): string {
  return kind === 'date' && (op === 'lt' || op === 'gt') ? op === 'lt' ? 'before' : 'after' : kind === 'checkbox' && (op === 'is' || op === 'is_not') ? op === 'is' ? 'is checked' : 'is not checked' : filterLabels[op];
}
export function typeQuery(type: string | null): Query {
  return { type, text: null, filters: [], sort: [], limit: null };
}
export function copyQuery(query: Query): Query {
  return { ...query, filters: query.filters.map(filter => ({ ...filter })), sort: query.sort.map(key => ({ ...key })), ...(query.columns ? { columns: query.columns.map(column => ({ ...column })) } : {}), ...(query.group ? { group: { ...query.group, collapsed: [...query.group.collapsed ?? []] } } : {}), ...(query.card ? { card: [...query.card] } : {}), ...(query.note_view ? { note_view: { ...query.note_view } } : {}), ...Object.fromEntries((['links', 'from', 'cites'] as const).filter(key => query[key]).map(key => [key, [...query[key]!]])) };
}
export function queriesEqual(left: Query, right: Query): boolean {
  return left.type === right.type && left.text === right.text && left.limit === right.limit
    && (left.offset ?? 0) === (right.offset ?? 0)
    && left.note_kind === right.note_kind
    && (left.source ?? 'notes') === (right.source ?? 'notes')
    && (left.purpose ?? '') === (right.purpose ?? '')
    && JSON.stringify(left.columns ?? null) === JSON.stringify(right.columns ?? null)
    && left.group?.key === right.group?.key && JSON.stringify(left.group?.collapsed ?? []) === JSON.stringify(right.group?.collapsed ?? [])
    && JSON.stringify(left.card ?? null) === JSON.stringify(right.card ?? null)
    && left.note_view?.layout === right.note_view?.layout && left.note_view?.grouping === right.note_view?.grouping
    && (['links', 'from', 'cites'] as const).every(key => (left[key] ?? []).length === (right[key] ?? []).length && (left[key] ?? []).every((value, index) => value === right[key]?.[index]))
    && left.filters.length === right.filters.length && left.filters.every((filter, index) => {
      const other = right.filters[index]!;
      return filter.field === other.field && filter.op === other.op && filter.value === other.value && !!filter.or_empty === !!other.or_empty;
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
export function filterLabel(filter: Filter, fields: readonly FieldDefinition[], notebook: NotebookClient): string {
  const definition = fields.find(field => field.id === filter.field);
  const name = definition?.name ?? filter.field;
  const value = definition?.kind === 'instance' && (filter.op === 'is' || filter.op === 'is_not') && filter.value
    ? notebook.lookup(filter.value)()?.text ?? filter.value
    : definition?.kind === 'choice' && definition.id.startsWith('@') ? definition.options.find(option => option.id === filter.value)?.text ?? filter.value : filter.value;
  if (definition?.kind === 'checkbox' && (filter.op === 'is' || filter.op === 'is_not') && filter.value?.toLowerCase() === 'true') {
    return `${name} ${filterOperatorLabel(filter.op, definition.kind)}`;
  }
  const dateLabel = value === 'today' ? 'today' : value === '-30d' ? '30 days ago' : value === '+7d' ? 'a week from now' : value;
  return `${name} ${filterOperatorLabel(filter.op, definition?.kind)}${filter.op === 'present' || filter.op === 'set' || filter.op === 'empty' ? '' : ` ${definition?.kind === 'date' ? dateLabel ?? '' : value ?? ''}`}${filter.or_empty ? ' or empty' : ''}`;
}
/** Adding a sort keeps the first key primary; choosing it again changes only its direction. */
export function chooseSort(query: Query, key: Pick<SortKey, 'by' | 'field'>, direction?: SortKey['direction']): Query {
  const existing = query.sort.find(candidate => sameSort(candidate, key));
  const next = { ...key, direction: direction ?? (existing?.direction === 'asc' ? 'desc' : 'asc') };
  return { ...query, sort: existing ? query.sort.map(candidate => sameSort(candidate, key) ? next : candidate) : [...query.sort, next] };
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
