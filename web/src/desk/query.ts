import type { FieldDefinition, Filter, PageView, Query, QueryRow } from '../api/types';
import type { OpenTarget, TableViewState } from '../shell/contract';
import type { NotebookClient } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { plainText } from '../outline/names';
import { copyQuery, filterLabel, typeQuery } from '../table/query';

export type DeskSelection = NonNullable<TableViewState['desk']>;
export type DeskColumn = DeskSelection['column'];
export const columnNames = ['Questions', 'Positions', 'Sources'] as const;

export function deskQuery(question?: string): Query {
  return {
    ...typeQuery(null), source: 'questions', layout: 'desk', group: { key: '@program' },
    filters: [{ field: '@state', op: 'is_not', value: 'parked' }, { field: '@state', op: 'is_not', value: 'answered' }],
    desk: {
      positions: { ...typeQuery(null), source: 'positions', filters: question ? [{ field: '@question', op: 'is', value: question }] : [] },
      sources: { ...typeQuery(null), source: 'sources' },
    },
  };
}
export const deskTarget = (question?: string): Extract<OpenTarget, { kind: 'table' }> => ({ kind: 'table', typeId: null, viewId: null, query: deskQuery(question) });
export function columnQuery(query: Query, column: DeskColumn): Query {
  if (column === 1) return query.desk?.positions ?? deskQuery().desk!.positions;
  if (column === 2) return query.desk?.sources ?? deskQuery().desk!.sources;
  const { desk: _, layout: __, ...questions } = query;
  return questions;
}
export function updateColumn(query: Query, column: DeskColumn, value: Query): Query {
  const next = copyQuery(query);
  if (column === 0) return { ...copyQuery(value), layout: 'desk', desk: next.desk };
  return { ...next, desk: { ...next.desk ?? deskQuery().desk!, [column === 1 ? 'positions' : 'sources']: copyQuery(value) } };
}
export function linkedQuery(query: Query, field: '@question' | '@cited_in', id: string | null): Query {
  const filters = query.filters.filter(filter => filter.field !== field);
  return { ...query, offset: 0, filters: id ? [{ field, op: 'is', value: id }, ...filters] : filters };
}
export function initialSelection(query: Query, stored?: DeskSelection): DeskSelection {
  return stored ? { ...stored } : {
    question: query.desk?.positions.filters.find(filter => filter.field === '@question' && filter.op === 'is')?.value ?? null,
    position: query.desk?.sources.filters.find(filter => filter.field === '@cited_in' && filter.op === 'is')?.value ?? null,
    source: null, column: 0,
  };
}
export function rowTarget(row: QueryRow): OpenTarget {
  const block = row.block.block;
  return { kind: 'page', pageId: block.page_id, ...(block.kind === 'block' ? { blockId: block.id } : {}) };
}
/** Restored filters render before query rows arrive; resolve their live references with the notebook receiver intact. */
export function deskConditionLabel(condition: Filter, fields: FieldDefinition[], notebook: NotebookClient, positions: readonly QueryRow[]): string {
  if (condition.field === '@cited_in' && condition.op === 'is') {
    const position = positions.find(row => row.block.block.id === condition.value);
    if (position) {
      const holder = position.attributes?.['@holder']?.map(value => value.text).join(' · ');
      return `Cited in is ${holder || plainText(position.block.block.text, id => notebook.lookup(id))}`;
    }
  }
  return plainText(filterLabel(condition, fields, notebook), id => notebook.lookup(id));
}
/** Authored locators and passage locations, restricted to this position's live subtree. */
export function positionLocators(page: PageView, position: string): Map<string, string[]> {
  const ids = new Set([position]);
  const blocks = [page.root, ...page.rows.map(row => row.block)];
  for (const block of blocks) if (!block.archived && block.parent_id && ids.has(block.parent_id)) ids.add(block.id);
  const result = new Map<string, string[]>();
  const add = (source: string, locator: string) => {
    if (!locator) return;
    const values = result.get(source) ?? [];
    if (!values.includes(locator)) values.push(locator);
    result.set(source, values);
  };
  for (const block of blocks) if (ids.has(block.id) && !block.archived) {
    for (const token of textTokens(block.text)) if (token.kind === 'reference' && token.id && token.locator) add(token.id, token.locator);
  }
  for (const capability of page.capabilities ?? []) if (ids.has(capability.block_id)) {
    for (const citation of capability.citations ?? []) add(citation.source_id, citation.locator || `¶${citation.ordinal + 1}`);
  }
  return result;
}
