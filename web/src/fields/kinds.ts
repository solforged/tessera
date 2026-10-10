import type { FieldKind } from '../api/types';

export const fieldKinds = ['text', 'number', 'date', 'checkbox', 'choice', 'instance', 'url', 'identifier'] as const;
export const partialDatePlaceholder = 'YYYY, YYYY-MM or YYYY-MM-DD';

export const kindLabels: Record<FieldKind, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  choice: 'Choice',
  instance: 'Instance',
  url: 'URL',
  identifier: 'Identifier',
};

/** Why a new field name is refused, or null; the characters `Name::` shorthand refuses are refused here too. */
export const fieldNameProblem = (name: string) => !name.trim() ? 'A field needs a name.' : name.trim().length > 60 ? 'Field names must be 60 characters or fewer.' : /[\\`[\]#:]/.test(name) ? 'Field names cannot contain [ ] # : ` or \\.' : null;

/** The checkbox spellings `fields::reading` accepts (crates/tessera-core/src/fields.rs); null for any other text. */
export function checkboxValue(text: string): boolean | null {
  const value = text.trim().toLowerCase();
  if (['yes', 'true', 'x', '[x]', 'done'].includes(value)) return true;
  if (['no', 'false', '[ ]', ''].includes(value)) return false;
  return null;
}
