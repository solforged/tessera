import type { FieldKind } from '../api/types';
import { taskFieldNames } from '../tasks/task-fields';
import type { MenuItem } from '../ui/Menu';

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

export const formatMenuNote = 'Changing format leaves value text unchanged.';

/** Why Task's built-in fields offer no other format; their menus list every kind disabled with this one note. */
export const taskFormatReason = 'Built-in task fields keep their format';

export const kindDescriptions: Record<FieldKind, string> = {
  text: 'Any written text',
  number: 'A figure, such as 12 or 3.5',
  date: 'A day, month or year, such as 1914-08',
  span: 'A range of dates, such as 1914–1918',
  checkbox: 'Yes or no',
  choice: 'One of a set of options',
  instance: 'A link to another atom',
  url: 'A web address',
  identifier: 'An ISBN, DOI or arXiv ID',
};

/** Format choices and their explanations stay the same in every definition editor. A reason disables every row and stands alone, so the menu stays short. */
export function formatMenuItems(current: FieldKind, select: (kind: FieldKind) => void, disabledReason?: string): MenuItem[] {
  return fieldKinds.map(kind => ({
    label: kindLabels[kind],
    secondary: disabledReason ? undefined : kindDescriptions[kind],
    checked: kind === current,
    disabledReason,
    action: () => select(kind),
  }));
}

/** A kind as a word inside a sentence: lowercase, except for the URL initialism. */
export function kindNoun(kind: FieldKind): string {
  return kind === 'url' ? 'URL' : kindLabels[kind].toLowerCase();
}

const initialisms: Record<string, true> = { url: true, isbn: true, issn: true, doi: true };

/**
 * The display name of a field. Built-ins are stored lowercase and read in sentence case (`Gist`, `Page range`) with
 * initialisms in capitals (`URL`), except Task's built-in fields, which the spec keeps lowercase (`status`, `deadline`);
 * user fields keep the casing they were given.
 */
export function fieldLabel(field: { name: string; built_in?: boolean }): string {
  if (!field.built_in || (taskFieldNames as readonly string[]).includes(field.name)) return field.name;
  return field.name.split(' ').map((word, at) => initialisms[word] ? word.toUpperCase() : at === 0 ? word.charAt(0).toLocaleUpperCase() + word.slice(1) : word).join(' ');
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
