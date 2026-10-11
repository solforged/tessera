import type { FieldDefinition, QueryRow } from '../api/types';
import { textTokens } from '../document/text-tokens';
import { sourceText } from './sources';
import type { TableSource } from './sources';

/** Block memberships remain visible, but never masquerade as titled notes. */
export function splitMembers(rows: readonly QueryRow[]): { notes: QueryRow[]; blocks: QueryRow[] } {
  const notes: QueryRow[] = []; const blocks: QueryRow[] = [];
  for (const row of rows) (row.block.block.kind === 'block' ? blocks : notes).push(row);
  return { notes, blocks };
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
