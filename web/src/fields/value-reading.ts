import type { BlockKind, FieldDefinition, FieldKind } from '../api/types';
import { checkboxValue } from './kinds';
import { partialFieldDate } from './value-options';
import { parseTaskDate } from '../tasks/date-input';
import { readSpan } from './span';

/** Problems decidable from the written value and definition, without fetching owner readings.
 * Mirrors crates/tessera-core/src/fields.rs reading; unresolved reference constraints stay unmarked. */
export function fieldValueProblem(field: FieldDefinition | undefined, text: string): string | undefined {
  const value = text.trim();
  if (!field || !value) return;
  switch (field.kind) {
    case 'number': return /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? undefined : 'not a number';
    case 'checkbox': return checkboxValue(value) === null ? 'not a checkbox' : undefined;
    case 'span': return readSpan(value) ? undefined : 'not a historical span';
    case 'date': {
      if (/^\[\[[^\]]+\]\]$/.test(value) || partialFieldDate(value) !== null) return;
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) && parseTaskDate(value, '2000-01-01');
      return parsed && parsed.ok ? undefined : 'not a date';
    }
    case 'choice': return field.options.some(option => value === `[[${option.id}]]`) ? undefined : 'not an option';
    case 'instance': return /^\[\[[^\]]+\]\]$/.test(value) ? undefined : 'not a reference';
    case 'url': return /^https?:\/\/[^/?#\s]+[^\s]*$/.test(value) ? undefined : 'not a URL';
  }
}

/**
 * The kind a new field's first value suggests: a whole reference is a relation, or a date when it names a
 * journal day; a calendar date, a number or a web address reads as such. Anything else stays text, and a bare
 * year counts as a number.
 */
export function guessFieldKind(text: string, targetKind: (id: string) => BlockKind | undefined = () => undefined): FieldKind | null {
  const value = text.trim();
  const reference = /^\[\[([0-9A-HJKMNP-TV-Z]{26})(?:\|[^\]]*)?\]\]$/i.exec(value);
  if (reference) return targetKind(reference[1]!) === 'journal' ? 'date' : 'instance';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && parseTaskDate(value, '2000-01-01').ok) return 'date';
  if (/^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) return 'number';
  if (/^https?:\/\/[^/?#\s]+[^\s]*$/.test(value)) return 'url';
  return null;
}
