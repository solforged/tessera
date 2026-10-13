import type { FieldKind } from '../api/types';

export const fieldKinds = ['text', 'number', 'date', 'checkbox', 'choice', 'instance', 'url', 'identifier'] as const;
export const partialDatePlaceholder = 'Year (1–9999), YYYY-MM or YYYY-MM-DD';

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

/** Why a field name is refused; creation and rename share syntax and notebook-wide uniqueness. */
export function fieldNameProblem(name: string, fields: readonly { id: string; name: string }[] = [], exceptId?: string): string | null {
  const text = name.trim();
  if (!text) return 'A field needs a name.';
  if (text.length > 60) return 'Field names must be 60 characters or fewer.';
  if (/[\\`[\]#:]/.test(text)) return 'Field names cannot contain [ ] # : ` or \\.';
  if (fields.some(field => field.id !== exceptId && field.name.trim().toLocaleLowerCase() === text.toLocaleLowerCase())) return `A field named ${text} already exists.`;
  return null;
}

/** The checkbox spellings `fields::reading` accepts (crates/tessera-core/src/fields.rs); null for any other text. */
export function checkboxValue(text: string): boolean | null {
  const value = text.trim().toLowerCase();
  if (['yes', 'true', 'x', '[x]', 'done'].includes(value)) return true;
  if (['no', 'false', '[ ]', ''].includes(value)) return false;
  return null;
}
