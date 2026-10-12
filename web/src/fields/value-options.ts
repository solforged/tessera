import type { FieldDefinition } from '../api/types';
import { parseTaskDate } from '../tasks/date-input';

export type ChoiceRow = { kind: 'option'; option: FieldDefinition['options'][number] } | { kind: 'create'; text: string } | { kind: 'clear' };

export function choiceRows(options: FieldDefinition['options'], query: string): ChoiceRow[] {
  const text = query.trim(), needle = text.toLowerCase();
  const matches = options.filter(option => option.text.toLowerCase().includes(needle));
  return [
    ...matches.map(option => ({ kind: 'option' as const, option })),
    ...(text && !options.some(option => option.text.toLowerCase() === needle) ? [{ kind: 'create' as const, text }] : []),
    { kind: 'clear' },
  ];
}

/** Valid partial field readings, without expanding them into an invented day. */
export function partialFieldDate(input: string): string | null {
  const text = input.trim();
  if (/^\d{1,4}$/.test(text) && Number(text) >= 1) return text;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(text) && Number(text.slice(0, 4)) >= 1) return text;
  return null;
}

export function hasValueEditor(field: FieldDefinition | undefined, text: string, contextDate: string): boolean {
  if (field?.kind === 'choice' || field?.kind === 'instance') return true;
  if (field?.kind !== 'date') return false;
  const parsed = parseTaskDate(text, contextDate);
  return partialFieldDate(text) !== null || parsed.ok && parsed.time === null;
}
