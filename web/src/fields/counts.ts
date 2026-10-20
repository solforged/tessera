import type { FieldDefinition } from '../api/types';
import { fieldLabel } from './kinds';

/** What a field's values count as, so bylines, sigla and `@creator` find creators by meaning rather than name. */
export const countsAsValues = ['creator', 'contributor', 'originator'] as const;
export type CountsAs = typeof countsAsValues[number];
export const countsLabels: Record<CountsAs | 'nothing', string> = { nothing: 'Nothing', creator: 'Creator', contributor: 'Contributor', originator: 'Originator' };
export const countsDescriptions: Record<CountsAs | 'nothing', string> = {
  nothing: 'Its values are only its own.',
  creator: 'Its values make the work: bylines, sigla, sorting and Creator.',
  contributor: 'Listed after the creators, never in a byline, siglum or sort.',
  originator: 'Who first proposed a concept, and where.',
};
export const fieldCounts = (field: { counts_as?: CountsAs | null } | undefined): CountsAs | null => field?.counts_as ?? null;
export const countsLabel = (field: { counts_as?: CountsAs | null } | undefined) => countsLabels[fieldCounts(field) ?? 'nothing'];

/** Why a field's Counts as cannot change, if it cannot: built-in fields count as the core says, and only names count. */
export function countsReason(field: FieldDefinition): string | undefined {
  if (field.built_in) return `${fieldLabel(field)} is built in and counts as ${fieldCounts(field) ?? 'nothing'}.`;
  if (field.kind !== 'text' && field.kind !== 'instance') return 'Only text and relation fields count as a creator, contributor or originator.';
  return undefined;
}
