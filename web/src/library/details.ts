import type { Block, ExtractedMetadata, FieldDefinition, FieldKind, ReadingState } from '../api/types';
import type { DocumentChange, NotebookClient, PageDocument, SourceDetailsEdit } from '../document/contract';
import { sourceState } from '../document/types';
import { addFieldOption, documentReady } from '../outline/source-fields';
import { sourceFieldName, valueLabel } from '../outline/source';
import { createInstance } from '../fields/instances';

export type SourceField = 'title' | 'subtitle' | 'creators' | 'firstPublished' | 'originalLanguage' | 'published' | 'publisher' | 'edition' | 'series' | 'number' | 'pages' | 'language' | 'identifiers' | 'url' | 'site' | 'description' | 'cover' | 'siglum' | 'citationKey' | 'state' | 'started' | 'finished' | 'tags';
export interface SourceCreator { id: string | null; name: string; role: 'author' | 'editor' | 'translator' }
export type SourceFieldValue = string | string[] | SourceCreator[];
export interface SourceFieldChange extends DocumentChange {}
export interface DerivedSourceSiglum { mark: string; basis: string }

/** Explain the derived alternative even while an authored Siglum field wins. Mirrors the service's family/site/title precedence. */
export function derivedSourceSiglum(creators: readonly SourceCreator[], site: string, title: string): DerivedSourceSiglum {
  const family = (name: string) => name.includes(',') ? name.split(',', 1)[0]! : name.trim().split(/\s+/).at(-1) ?? '';
  const author = creators.find(creator => creator.role === 'author');
  const editor = creators.find(creator => creator.role === 'editor');
  for (const candidate of [author ? family(author.name) : '', editor ? family(editor.name) : '', site, title.split(/\s+/).find(word => /\p{Alphabetic}/u.test(word)) ?? '']) {
    const letters = candidate.match(/\p{Alphabetic}/gu) ?? [];
    if (letters.length) return { mark: letters.slice(0, 3).join('').toUpperCase(), basis: letters.join('') };
  }
  return { mark: '?', basis: 'the source title' };
}

export const emptyMetadata = (): ExtractedMetadata => ({ title: null, subtitle: null, creators: [], published: null, publisher: null, language: null, identifiers: [], unique_id: null, url: null, site: null, description: null, cover: null });
type OrdinaryField = Exclude<SourceField, 'title' | 'creators' | 'citationKey' | 'state' | 'tags'>;
const fields: Record<OrdinaryField, readonly [string, FieldKind]> = {
  subtitle: ['Subtitle', 'text'], firstPublished: ['First published', 'date'], originalLanguage: ['Original language', 'text'],
  published: ['Published', 'date'], publisher: ['Publisher', 'text'], edition: ['Edition', 'text'], series: ['Series', 'text'],
  number: ['Number', 'number'], pages: ['Pages', 'number'], language: ['Language', 'text'], identifiers: ['Identifier', 'identifier'],
  url: ['URL', 'url'], site: ['Site', 'text'], description: ['Description', 'text'], cover: ['Cover', 'text'], siglum: ['Siglum', 'text'],
  started: ['Started', 'date'], finished: ['Finished', 'date'],
};
const roles = ['author', 'editor', 'translator'] as const;
const writes = new WeakMap<NotebookClient, Promise<unknown>>();
interface FieldPreparation { pageId: string; definitions: FieldDefinition[] }

/** Definition/reference creation and metadata commits share a queue, so concurrent fields cannot create duplicate definitions. */
function prepareWrite<T>(notebook: NotebookClient, work: () => Promise<T>): Promise<T> {
  const pending = (writes.get(notebook) ?? Promise.resolve()).then(work, work);
  writes.set(notebook, pending.catch(() => undefined));
  return pending;
}

export function sourceEntries(doc: PageDocument, definitions: readonly FieldDefinition[]): Map<string, string[]> {
  const byId = new Map(definitions.map(field => [field.id, field]));
  const entries = new Map<string, string[]>();
  for (const id of doc.outline.children(doc.pageId)) {
    const block = doc.block(id);
    if (!block || block.archived) continue;
    const name = sourceFieldName(block.text, byId)?.toLowerCase();
    if (name) entries.set(name, [...entries.get(name) ?? [], id]);
  }
  return entries;
}

export function sourceFieldValue(doc: PageDocument, notebook: NotebookClient, definitions: readonly FieldDefinition[], field: SourceField): SourceFieldValue {
  if (field === 'title') return doc.root()?.text ?? '';
  if (field === 'citationKey') return doc.root()?.source?.citation_key ?? '';
  if (field === 'state') return doc.root()?.source?.state ?? '';
  if (field === 'tags') return [...(doc.root()?.manual_types ?? [])];
  const entries = sourceEntries(doc, definitions);
  const values = (name: string) => (entries.get(name.toLowerCase()) ?? []).flatMap(id => doc.outline.children(id)).flatMap(id => {
    const block = doc.block(id);
    return block && !block.archived && block.text.trim() ? [block.text] : [];
  });
  if (field === 'creators') return roles.flatMap(role => values(role).map(text => {
    const id = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(text.trim())?.[1] ?? null;
    return { id, name: valueLabel(text, id => notebook.lookup(id)), role };
  }));
  const found = values(fields[field][0]).map(text => valueLabel(text, id => notebook.lookup(id)));
  return field === 'identifiers' ? found : found[0] ?? '';
}

export function sourceMetadata(doc: PageDocument, notebook: NotebookClient, definitions: readonly FieldDefinition[]): ExtractedMetadata {
  const text = (field: SourceField) => sourceFieldValue(doc, notebook, definitions, field) as string;
  return { ...emptyMetadata(), title: text('title'), subtitle: text('subtitle') || null,
    creators: (sourceFieldValue(doc, notebook, definitions, 'creators') as SourceCreator[]).map(({ name, role }) => ({ name, role })),
    published: text('published') || null, publisher: text('publisher') || null, language: text('language') || null,
    identifiers: sourceFieldValue(doc, notebook, definitions, 'identifiers') as string[], cover: text('cover') || null,
    url: text('url') || null, site: text('site') || null, description: text('description') || null };
}

const nameTokens = (name: string) => name.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Pages that may name the same person: the same words in any order, where a word may be an initial or a prefix of
 * the other ("Aurelius, Marcus", "M. Aurelius" and "Marcus Aurelius"). One side may carry one extra word. An exact
 * title is left out, since saving links to it already.
 */
export function similarPages(name: string, pages: readonly Block[], limit = 3): Block[] {
  const query = nameTokens(name);
  if (!query.some(token => token.length >= 3)) return [];
  const key = name.trim().toLocaleLowerCase();
  const matches = (shorter: string[], longer: string[]) => {
    const free = [...longer];
    let whole = false;
    for (const token of shorter) {
      const index = free.findIndex(other => other.startsWith(token) || token.startsWith(other));
      if (index < 0) return false;
      whole ||= token.length >= 3 && free[index] === token;
      free.splice(index, 1);
    }
    return whole;
  };
  return pages.filter(page => {
    if (page.kind !== 'page' || page.archived || page.text.trim().toLocaleLowerCase() === key) return false;
    const tokens = nameTokens(page.text);
    if (!tokens.length || Math.abs(tokens.length - query.length) > 1) return false;
    return query.length <= tokens.length ? matches(query, tokens) : matches(tokens, query);
  }).slice(0, limit);
}

export function validateSourceValue(field: SourceField, value: SourceFieldValue): SourceFieldValue {
  if (field === 'creators') {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'object' || !roles.includes(item.role) || !item.name.trim())) throw new Error('Each creator needs a name and role.');
    return (value as SourceCreator[]).map(item => ({ ...item, name: item.name.trim() }));
  }
  if (field === 'identifiers' || field === 'tags') {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Enter a list of values.');
    const values = (value as string[]).map(item => item.trim()).filter(Boolean);
    if (field === 'tags' && values.some(item => /[\[\]\r\n]/.test(item))) throw new Error('Tag names cannot contain brackets or line breaks.');
    return values.filter((item, index) => values.findIndex(other => other.toLowerCase() === item.toLowerCase()) === index);
  }
  if (typeof value !== 'string') throw new Error('Enter one value.');
  const text = value.trim();
  if (field === 'title' && !text) throw new Error('A title is required.');
  if (['firstPublished', 'published', 'started', 'finished'].includes(field) && text) {
    const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
    const year = Number(match?.[1]), month = Number(match?.[2] ?? 1), day = Number(match?.[3] ?? 1);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!match || year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!) throw new Error('Use YYYY, YYYY-MM or YYYY-MM-DD.');
  }
  if (field === 'pages' && text) {
    const count = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(count) || count < 1) throw new Error('Pages must be a positive whole number.');
  }
  if (field === 'number' && text && (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text)))) throw new Error('Enter a finite number.');
  if (field === 'siglum' && text && !/^[A-Za-z]{1,4}$/.test(text)) throw new Error('Use one to four letters, or leave blank to derive the siglum.');
  if (field === 'citationKey' && text && !/^[A-Za-z][A-Za-z0-9_:-]{0,63}$/.test(text)) throw new Error('Citation keys must start with a letter and contain at most 64 letters, digits, underscores, colons or hyphens.');
  if (field === 'state' && !['inbox', 'reading', 'finished', 'abandoned'].includes(text)) throw new Error('Choose a reading state.');
  return text;
}

async function prepareField(notebook: NotebookClient, context: FieldPreparation, label: string, kind: FieldKind, values: string[]): Promise<{ id: string; values: string[] } | undefined> {
  let definition = context.definitions.find(field => field.name.toLowerCase() === label.toLowerCase());
  if (!definition && !values.length) return undefined;
  if (!definition) {
    const doc = notebook.open(context.pageId);
    try {
      await documentReady(doc);
      const result = doc.edit({ kind: 'addField', name: label, value: kind });
      if (!result.ok) throw new Error(result.reason);
      await doc.flush();
      definition = { id: result.created[0]!, name: label, kind, revision: doc.block(result.created[0]!)!.revision, options: [], targets: [] };
      if (kind === 'instance') {
        const targets = await Promise.all(['Person', 'Group'].map(async title => (await notebook.pageByTitle(title, true))!));
        const targeted = doc.edit({ kind: 'fieldTargets', definition, targets });
        if (!targeted.ok) throw new Error(targeted.reason);
        await doc.flush();
        definition = { ...definition, targets, revision: definition.revision + 1 };
      }
      context.definitions.push(definition);
    } finally { doc.release(); }
  }
  if (kind === 'instance' || definition.kind === 'instance') {
    values = await Promise.all(values.map(async value => {
      const reference = /^\[\[[^\]|]+\]\]$/.test(value) ? value.slice(2, -2) : undefined;
      const name = value.includes(',') ? value.split(',').reverse().map(part => part.trim()).join(' ') : value;
      let id = reference ?? await notebook.pageByTitle(value, false) ?? await notebook.pageByTitle(name, false);
      if (!id) id = (await createInstance(notebook, name, 'Person')).id;
      else {
        const kinds = await notebook.api.noteKinds(id);
        if (!kinds.some(kind => kind.key !== 'unfiled')) {
          const page = await notebook.api.block(id);
          await notebook.commit([{ op: 'add_type', id, base_revision: page.revision, title: 'Person' }], 'File creator');
        }
      }
      return `[[${id}]]`;
    }));
  } else if (definition.kind === 'choice') {
    const field = definition;
    values = await Promise.all(values.map(async value => `[[${await addFieldOption(notebook, field, value)}]]`));
  }
  return { id: definition.id, values };
}

async function prepareSourceField(doc: PageDocument, notebook: NotebookClient, context: FieldPreparation, field: SourceField, value: SourceFieldValue): Promise<SourceDetailsEdit> {
  const edit: SourceDetailsEdit = { kind: 'sourceDetails', fields: [] };
  if (field === 'title') edit.title = value as string;
  else if (field === 'tags') edit.tags = value as string[];
  else if (field === 'state' || field === 'citationKey') {
    const source = sourceState(doc.root()?.source);
    if (!source) throw new Error('This page is no longer a source.');
    edit.source = { ...source, ...(field === 'state' ? { state: value as ReadingState } : { citation_key: (value as string) || null }) };
  } else {
    const entries = sourceEntries(doc, context.definitions);
    const pending = field === 'creators'
      ? roles.map(role => ({ label: role[0]!.toUpperCase() + role.slice(1), kind: 'instance' as const,
        values: (value as SourceCreator[]).filter(creator => creator.role === role).map(creator => creator.id ? `[[${creator.id}]]` : creator.name) }))
      : [{ label: fields[field][0], kind: fields[field][1], values: field === 'identifiers' ? value as string[] : value || ['url', 'site', 'description', 'cover'].includes(field) ? [value as string] : [] }];
    for (const { label, kind, values } of pending) {
      const prepared = await prepareField(notebook, context, label, kind, values);
      if (prepared) edit.fields.push({ ...prepared, entries: entries.get(label.toLowerCase()) ?? [] });
    }
  }
  return edit;
}

/** One field, one acknowledged cross-page command, one exact undo step. */
export async function saveSourceField(docs: readonly PageDocument[], notebook: NotebookClient, field: SourceField, value: SourceFieldValue): Promise<SourceFieldChange> {
  let normalized = validateSourceValue(field, value);
  return prepareWrite(notebook, async () => {
    await Promise.all(docs.map(async doc => { await documentReady(doc); await doc.flush(); }));
    if (field === 'identifiers') normalized = (await notebook.api.normalizeMetadata({ ...emptyMetadata(), title: docs[0]?.root()?.text ?? 'Source', identifiers: normalized as string[] })).identifiers;
    const definitions = await notebook.api.fields();
    const context: FieldPreparation = { pageId: definitions.page_id, definitions: [...definitions.fields] };
    const edits = [];
    for (const doc of docs) edits.push({ pageId: doc.pageId, edit: await prepareSourceField(doc, notebook, context, field, normalized) });
    return notebook.editSourceDetails(edits);
  });
}

/** Shared preparation for manual details, cover replacement and fill-only-empty lookup. */
async function prepareMetadata(doc: PageDocument, notebook: NotebookClient, context: FieldPreparation, metadata: ExtractedMetadata, onlyMissing: boolean, coverOnly: boolean): Promise<{ edit: SourceDetailsEdit; count: number }> {
  const edit: SourceDetailsEdit = { kind: 'sourceDetails', fields: [] };
  const previous = sourceMetadata(doc, notebook, context.definitions);
  const entries = sourceEntries(doc, context.definitions);
  const labels = coverOnly ? ['cover'] as const : ['subtitle', 'published', 'publisher', 'language', 'identifiers', 'url', 'site', 'description', ...(onlyMissing ? ['cover' as const] : [])] as const;
  for (const field of labels) {
    const value = validateSourceValue(field, field === 'identifiers' ? metadata.identifiers : metadata[field] ?? '');
    const old = field === 'identifiers' ? previous.identifiers : previous[field] ?? '';
    if (onlyMissing && old.length || JSON.stringify(old) === JSON.stringify(value)) continue;
    const prepared = await prepareSourceField(doc, notebook, context, field, value);
    edit.fields.push(...prepared.fields);
  }
  if (!coverOnly) for (const role of roles) {
    const names = metadata.creators.filter(creator => creator.role === role).map(creator => creator.name.trim()).filter(Boolean);
    const old = previous.creators.filter(creator => creator.role === role).map(creator => creator.name);
    if (onlyMissing && old.length || JSON.stringify(old) === JSON.stringify(names)) continue;
    const label = role[0]!.toUpperCase() + role.slice(1);
    const prepared = await prepareField(notebook, context, label, 'instance', names);
    if (prepared) edit.fields.push({ ...prepared, entries: entries.get(role) ?? [] });
  }
  if (!onlyMissing && !coverOnly) edit.title = validateSourceValue('title', metadata.title ?? '') as string;
  return { edit, count: edit.fields.length + Number(edit.title !== undefined && edit.title !== previous.title) };
}

/** Preserve the manual editor's page-local history while sharing the inspector's write path. */
export async function saveDetails(doc: PageDocument, notebook: NotebookClient, metadata: ExtractedMetadata, onlyMissing = false, coverOnly = false): Promise<number> {
  return prepareWrite(notebook, async () => {
    const normalized = coverOnly ? metadata : await notebook.api.normalizeMetadata(metadata);
    const definitions = await notebook.api.fields();
    const prepared = await prepareMetadata(doc, notebook, { pageId: definitions.page_id, definitions: [...definitions.fields] }, normalized, onlyMissing, coverOnly);
    const result = doc.edit(prepared.edit);
    if (!result.ok) throw new Error(result.reason);
    await doc.flush();
    return prepared.count;
  });
}

/** Lookups prepare separately; every filled source field commits and undoes together. */
export async function fillMissingSourceDetails(docs: readonly PageDocument[], notebook: NotebookClient): Promise<SourceFieldChange> {
  return prepareWrite(notebook, async () => {
    await Promise.all(docs.map(async doc => { await documentReady(doc); await doc.flush(); }));
    const definitions = await notebook.api.fields();
    const context: FieldPreparation = { pageId: definitions.page_id, definitions: [...definitions.fields] };
    const edits = [];
    for (const doc of docs) {
      const current = sourceMetadata(doc, notebook, context.definitions);
      const identifier = current.identifiers[0];
      if (!identifier) continue;
      const [preview, view] = await Promise.all([notebook.api.lookup(identifier), notebook.api.source(doc.pageId)]);
      const snapshot = view.snapshots.find(item => item.id === view.source.current_snapshot_id)?.metadata;
      const metadata = { ...preview.metadata, title: current.title, cover: preview.cover_url };
      const entries = sourceEntries(doc, context.definitions);
      // Snapshot-only values already shown by the inspector are not missing.
      for (const field of ['url', 'site', 'description', 'cover'] as const) {
        if (!entries.has(fields[field][0].toLowerCase()) && snapshot?.[field]) metadata[field] = null;
      }
      const normalized = await notebook.api.normalizeMetadata(metadata);
      const prepared = await prepareMetadata(doc, notebook, context, normalized, true, false);
      edits.push({ pageId: doc.pageId, edit: prepared.edit });
    }
    return notebook.editSourceDetails(edits);
  });
}
