import type { CountsAs, FieldDefinition, FieldKind, FieldRole, Operation } from '../api/types';
import { parseCardText } from '../core/card-text';

export const fieldKinds = [
  'text',
  'number',
  'date',
  'span',
  'checkbox',
  'choice',
  'instance',
  'url',
  'identifier',
] as const satisfies readonly FieldKind[];
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

/** A kind as a word inside a sentence: lowercase, except for the URL initialism. */
export function kindNoun(kind: FieldKind): string {
  return kind === 'url' ? 'URL' : kindLabels[kind].toLowerCase();
}

const initialisms: Record<string, true> = { url: true, isbn: true, issn: true, doi: true };

/**
 * The display name of a field. Built-ins are stored lowercase and read in sentence case (`Gist`, `Page range`,
 * `Scheduled`, `Deadline`) with initialisms in capitals (`URL`); user fields keep the casing they were given.
 */
export function fieldLabel(field: { name: string; built_in?: boolean }): string {
  if (!field.built_in) return field.name;
  return field.name
    .split(' ')
    .map((word, at) =>
      initialisms[word] ? word.toUpperCase() : at === 0 ? word.charAt(0).toLocaleUpperCase() + word.slice(1) : word,
    )
    .join(' ');
}

/** Why a field name is refused; creation and rename share syntax and notebook-wide uniqueness. */
export function fieldNameProblem(
  name: string,
  fields: readonly { id: string; name: string }[] = [],
  exceptId?: string,
): string | null {
  const text = name.trim();
  if (!text) return 'A field needs a name.';
  if (text.length > 60) return 'Field names must be 60 characters or fewer.';
  if (/[\\`[\]#:]/.test(text)) return 'Field names cannot contain [ ] # : ` or \\.';
  if (fields.some(field => field.id !== exceptId && field.name.trim().toLocaleLowerCase() === text.toLocaleLowerCase()))
    return `A field named ${text} already exists.`;
  return null;
}

/** The checkbox spellings `fields::reading` accepts (crates/tessera-core/src/fields.rs); null for any other text. */
export function checkboxValue(text: string): boolean | null {
  const value = text.trim().toLowerCase();
  if (['yes', 'true', 'x', '[x]', 'done'].includes(value)) return true;
  if (['no', 'false', '[ ]', ''].includes(value)) return false;
  return null;
}

/** What a field's values count as, so bylines, sigla and `@creator` find creators by meaning rather than name. */
export const countsAsValues = ['creator', 'contributor', 'originator'] as const satisfies readonly CountsAs[];
export type { CountsAs };
export const countsLabels: Record<CountsAs | 'nothing', string> = {
  nothing: 'Nothing',
  creator: 'Creator',
  contributor: 'Contributor',
  originator: 'Originator',
};
export const countsDescriptions: Record<CountsAs | 'nothing', string> = {
  nothing: 'Its values are only its own.',
  creator: 'Its values make the work: bylines, sigla, sorting and Creator.',
  contributor: 'Listed after the creators, never in a byline, siglum or sort.',
  originator: 'Who first proposed a concept, and where.',
};
export const fieldCounts = (field: { counts_as?: CountsAs | null } | undefined): CountsAs | null =>
  field?.counts_as ?? null;
export const countsLabel = (field: { counts_as?: CountsAs | null } | undefined) =>
  countsLabels[fieldCounts(field) ?? 'nothing'];

/** Why a field's Counts as cannot change, if it cannot: built-in fields count as the core says, and only names count. */
export function countsReason(field: FieldDefinition): string | undefined {
  if (field.built_in) return `${fieldLabel(field)} is built in and counts as ${fieldCounts(field) ?? 'nothing'}.`;
  if (field.kind !== 'text' && field.kind !== 'instance')
    return 'Only text and relation fields count as a creator, contributor or originator.';
  return undefined;
}

export const fieldRoles = ['standfirst', 'attribute', 'prose', 'citation'] as const satisfies readonly FieldRole[];
export type { FieldRole };
export const roleLabels: Record<FieldRole, string> = {
  standfirst: 'Standfirst',
  attribute: 'Attribute',
  prose: 'Prose',
  citation: 'Citation',
};
export const roleDescriptions: Record<FieldRole, string> = {
  standfirst: 'A sentence below the atom, without a label.',
  attribute: 'A compact label and value in the field bed.',
  prose: 'A full-width passage below the field bed.',
  citation: 'References as siglum and locator in the field bed.',
};
export const fieldRole = (field: { role?: FieldRole } | undefined): FieldRole => field?.role ?? 'attribute';

export function matchFieldEntry(text: string): { name: string; value: string } | null {
  const match = /^([^\\`[\]#:]{1,60}?)::\s?(.*)$/.exec(text);
  if (!match || !match[1]!.trim()) return null;
  const name = match[1]!.trim();
  const prefix = parseCardText(name);
  if (prefix.cards.length || prefix.problems.length) return null;
  return { name, value: match[2]! };
}

export function fieldEntryText(fieldId: string): string {
  return `[[${fieldId}]]`;
}

/** The Links to entry for sources, which are a capability rather than a type page; mirrors the core's `SOURCE_TARGET`. */
export const SOURCE_TARGET = 'source';

/** Links to entries that name type pages, leaving out Source. */
export const typeTargets = (targets: readonly string[]) => targets.filter(id => id !== SOURCE_TARGET);

/** Makes a new page a source, as a manual record waiting to be read. */
export const sourceOperation = (id: string, base_revision: number): Extract<Operation, { op: 'set_source' }> => ({
  op: 'set_source',
  id,
  base_revision,
  source: { format: 'record', state: 'inbox', origin: null, match_key: null, citation_key: null },
});
