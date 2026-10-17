import type { FieldDefinition, FieldKind, Filter, FilterOp, Query, SortKey } from '../api/types';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { parseCardText } from '../review/card-text';
import { targetLabel } from '../outline/names';

export const filterLabels: Record<FilterOp, string> = {
  is: 'is', is_not: 'is not', contains: 'contains', gt: '>', gte: '≥', lt: '<', lte: '≤', present: 'has the field', set: 'has a value', empty: 'is empty',
  overlaps: 'overlaps', before: 'before', after: 'after',
};
const dateFilterLabels: Partial<Record<FilterOp, string>> = { gt: 'after', gte: 'on or after', lt: 'before', lte: 'on or before' };
export function filterOperators(kind: FieldKind = 'text'): FilterOp[] {
  if (kind === 'checkbox') return ['is', 'is_not'];
  if (kind === 'choice' || kind === 'instance') return ['is', 'is_not', 'set', 'empty'];
  if (kind === 'span') return ['overlaps', 'before', 'after', 'is', 'is_not', 'present', 'set', 'empty'];
  return ['is', 'is_not', 'contains', ...(kind === 'number' || kind === 'date' ? ['gt', 'gte', 'lt', 'lte'] as const : []), 'present', 'set', 'empty'];
}
export function filterOperatorLabel(op: FilterOp, kind?: FieldKind): string {
  return kind === 'date' && dateFilterLabels[op] ? dateFilterLabels[op]! : kind === 'checkbox' && (op === 'is' || op === 'is_not') ? op === 'is' ? 'is checked' : 'is not checked' : filterLabels[op];
}
export function typeQuery(type: string | null): Query {
  return { type, text: null, filters: [], sort: [], limit: null };
}
/** A page's Table: a project lists its tasks, by ancestry or explicit Project field as its task query does, rather than members of a type it is not. */
export function pageTableTarget(pageId: string, project: boolean): Extract<OpenTarget, { kind: 'table' }> {
  return project
    ? { kind: 'table', typeId: null, viewId: null, query: { ...typeQuery(null), source: 'tasks', filters: [{ field: '@project', op: 'is', value: pageId }] } }
    : { kind: 'table', typeId: pageId, viewId: null, query: typeQuery(pageId) };
}
export function copyQuery(query: Query): Query {
  const desk = query.desk ? { positions: copyQuery(query.desk.positions), sources: copyQuery(query.desk.sources) } : undefined;
  return { ...query, ...(desk ? { desk } : {}), filters: query.filters.map(filter => ({ ...filter })), sort: query.sort.map(key => ({ ...key })), ...(query.columns ? { columns: query.columns.map(column => ({ ...column })) } : {}), ...(query.group ? { group: { ...query.group, ...(query.group.collapsed ? { collapsed: [...query.group.collapsed] } : {}) } } : {}), ...(query.card ? { card: [...query.card] } : {}), ...(query.field_names ? { field_names: { ...query.field_names } } : {}), ...(query.note_view ? { note_view: { ...query.note_view } } : {}), ...Object.fromEntries((['links', 'from', 'cites'] as const).filter(key => query[key]).map(key => [key, [...query[key]!]])) };
}

/** A saved note index and its table use the same field grouping. */
export function noteTableQuery(query: Query): Query {
  const next = copyQuery(query);
  if (!next.note_view) return next;
  next.note_view.layout = 'table';
  const field = next.note_view.grouping.startsWith('field:') ? next.note_view.grouping.slice(6) : null;
  if (field && next.group?.key !== field) next.group = { key: field, collapsed: [] };
  else if (!field && query.note_view?.layout === 'index') next.group = undefined;
  return next;
}

/** Definition identities used by a recipe, excluding built-in attributes and group values. */
export function queryFieldIds(query: Query): string[] {
  return [...new Set([
    ...query.filters.map(filter => filter.field),
    ...query.sort.flatMap(sort => sort.by === 'field' && sort.field ? [sort.field] : []),
    ...(query.columns ?? []).map(column => column.key),
    ...(query.group ? [query.group.key] : []),
    ...(query.card ?? []),
    ...(query.note_view?.grouping.startsWith('field:') ? [query.note_view.grouping.slice(6)] : []),
    ...(query.desk ? [...queryFieldIds(query.desk.positions), ...queryFieldIds(query.desk.sources)] : []),
  ])].filter(id => !id.startsWith('@'));
}

export function retainFieldNames(query: Query): Query {
  if (!query.field_names) return query;
  const used = new Set(queryFieldIds(query));
  const field_names = Object.fromEntries(Object.entries(query.field_names).filter(([id]) => used.has(id)));
  const next = { ...query };
  if (Object.keys(field_names).length) next.field_names = field_names;
  else delete next.field_names;
  return next;
}

export function remapQueryField(query: Query, from: string, to: string): Query {
  const key = (id: string) => id === from ? to : id;
  return retainFieldNames({
    ...copyQuery(query),
    filters: query.filters.map(filter => ({ ...filter, field: key(filter.field) })),
    sort: query.sort.map(sort => ({ ...sort, field: sort.field ? key(sort.field) : null })),
    ...(query.columns ? { columns: query.columns.map(column => ({ ...column, key: key(column.key) })) } : {}),
    ...(query.group ? { group: { ...query.group, key: key(query.group.key), ...(query.group.collapsed ? { collapsed: query.group.collapsed.map(key) } : {}) } } : {}),
    ...(query.card ? { card: query.card.map(key) } : {}),
    ...(query.note_view ? { note_view: { ...query.note_view, grouping: query.note_view.grouping === `field:${from}` ? `field:${to}` : query.note_view.grouping } } : {}),
    ...(query.desk ? { desk: { positions: remapQueryField(query.desk.positions, from, to), sources: remapQueryField(query.desk.sources, from, to) } } : {}),
  });
}

export function removeQueryField(query: Query, id: string): Query {
  const next = retainFieldNames({
    ...copyQuery(query),
    filters: query.filters.filter(filter => filter.field !== id),
    sort: query.sort.filter(sort => sort.by !== 'field' || sort.field !== id),
    ...(query.columns ? { columns: query.columns.filter(column => column.key !== id) } : {}),
    ...(query.group?.key === id ? { group: undefined } : {}),
    ...(query.card ? { card: query.card.filter(key => key !== id) } : {}),
    ...(query.note_view?.grouping === `field:${id}` ? { note_view: { ...query.note_view, grouping: 'letter' } } : {}),
    ...(query.desk ? { desk: { positions: removeQueryField(query.desk.positions, id), sources: removeQueryField(query.desk.sources, id) } } : {}),
  });
  if (!next.type && !next.text && !next.filters.length && !next.note_kind && !next.source) next.source = 'notes';
  return next;
}

export function missingQueryFields(query: Query, fields: readonly FieldDefinition[]) {
  const present = new Set(fields.map(field => field.id));
  return queryFieldIds(query).filter(id => !present.has(id)).map(id => ({ id, name: query.field_names?.[id] ?? 'Missing field' }));
}
export function queriesEqual(left: Query, right: Query): boolean {
  return left.type === right.type && left.text === right.text && left.limit === right.limit
    && (left.offset ?? 0) === (right.offset ?? 0)
    && left.note_kind === right.note_kind
    && (left.source ?? 'notes') === (right.source ?? 'notes')
    && (left.layout ?? 'table') === (right.layout ?? 'table')
    && (left.purpose ?? '') === (right.purpose ?? '')
    && (left.layout ?? 'table') === (right.layout ?? 'table')
    && (!left.desk && !right.desk || !!left.desk && !!right.desk && queriesEqual(left.desk.positions, right.desk.positions) && queriesEqual(left.desk.sources, right.desk.sources))
    && JSON.stringify(left.columns ?? null) === JSON.stringify(right.columns ?? null)
    && left.group?.key === right.group?.key && JSON.stringify(left.group?.collapsed ?? []) === JSON.stringify(right.group?.collapsed ?? [])
    && JSON.stringify(left.card ?? null) === JSON.stringify(right.card ?? null)
    && JSON.stringify(left.field_names ?? {}) === JSON.stringify(right.field_names ?? {})
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
export function sortLabel(key: SortKey, fields: readonly FieldDefinition[], names?: Record<string, string>): string {
  const name = key.by === 'field' ? fields.find(field => field.id === key.field)?.name ?? names?.[key.field ?? ''] ?? 'Missing field'
    : { title: 'Title', created: 'Created', updated: 'Updated' }[key.by];
  return `${name} ${key.direction === 'asc' ? '↑' : '↓'}`;
}
export function filterLabel(filter: Filter, fields: readonly FieldDefinition[], notebook: NotebookClient, names?: Record<string, string>): string {
  const definition = fields.find(field => field.id === filter.field);
  const name = definition?.name ?? names?.[filter.field] ?? 'Missing field';
  const value = definition?.kind === 'instance' && (filter.op === 'is' || filter.op === 'is_not') && filter.value
    ? (target => !target ? filter.value : target.kind === 'page' ? target.text : targetLabel(target.text, id => notebook.lookup(id)) || 'Empty block')(notebook.lookup(filter.value)())
    : definition?.kind === 'choice' && definition.id.startsWith('@') ? definition.options.find(option => option.id === filter.value)?.text ?? filter.value : filter.value;
  if (filter.field === '@resolved' && (filter.op === 'is' || filter.op === 'is_not') && (value === 'true' || value === 'false')) {
    return (value === 'true') === (filter.op === 'is') ? 'Resolved' : 'Not resolved';
  }
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
