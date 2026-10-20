import type { FieldKind } from '../api/types';

export const fieldKinds = ['text', 'number', 'date', 'span', 'checkbox', 'choice', 'instance', 'url', 'identifier'] as const;
export const partialDatePlaceholder = 'Year (1–9999), YYYY-MM or YYYY-MM-DD';

export const kindLabels: Record<FieldKind, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  span: 'Span',
  checkbox: 'Checkbox',
  choice: 'Choice',
  instance: 'Relation',
  url: 'URL',
  identifier: 'Identifier',
};

/** A kind as a word inside a sentence: lowercase, except for the URL initialism. */
export function kindNoun(kind: FieldKind): string {
  return kind === 'url' ? 'URL' : kindLabels[kind].toLowerCase();
}

/** A field's name as people read it: built-ins are stored lowercase (`status`) but read in sentence case. */
export function fieldLabel(field: { name: string; built_in?: boolean }): string {
  return field.built_in ? field.name.charAt(0).toLocaleUpperCase() + field.name.slice(1) : field.name;
}

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
