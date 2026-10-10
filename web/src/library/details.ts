import type { Block, ExtractedMetadata, FieldDefinition, FieldKind } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import { addFieldOption, documentReady } from '../outline/source-fields';
import { sourceFieldName, valueLabel } from '../outline/source';

export const emptyMetadata = (): ExtractedMetadata => ({ title: null, subtitle: null, creators: [], published: null, publisher: null, language: null, identifiers: [], unique_id: null, url: null, site: null, description: null, cover: null });
const labels = [ ['Subtitle', 'text'], ['Author', 'instance'], ['Editor', 'instance'], ['Translator', 'instance'], ['Published', 'date'], ['Publisher', 'text'], ['Language', 'text'], ['Identifier', 'identifier'], ['Cover', 'text'] ] as const;

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

export function sourceMetadata(doc: PageDocument, notebook: NotebookClient, definitions: readonly FieldDefinition[]): ExtractedMetadata {
  const entries = sourceEntries(doc, definitions);
  const values = (name: string) => (entries.get(name) ?? []).flatMap(id => doc.outline.children(id)).flatMap(id => {
    const block = doc.block(id);
    return block && !block.archived && block.text.trim() ? [valueLabel(block.text, id => notebook.lookup(id))] : [];
  });
  return { ...emptyMetadata(), title: doc.root()?.text ?? '', subtitle: values('subtitle')[0] ?? null,
    creators: (['author', 'editor', 'translator'] as const).flatMap(role => values(role).map(name => ({ name, role }))),
    published: values('published')[0] ?? null, publisher: values('publisher')[0] ?? null, language: values('language')[0] ?? null,
    identifiers: values('identifier'), cover: values('cover')[0] ?? null };
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

/** Prepare references, then change the source's ordinary fields in one undo step. */
export async function saveDetails(doc: PageDocument, notebook: NotebookClient, metadata: ExtractedMetadata, onlyMissing = false, coverOnly = false): Promise<number> {
  const normalized = coverOnly ? metadata : await notebook.api.normalizeMetadata(metadata);
  const currentFields = await notebook.api.fields();
  const entries = sourceEntries(doc, currentFields.fields);
  const previous = sourceMetadata(doc, notebook, currentFields.fields);
  const valuesFor = (value: ExtractedMetadata, name: string): string[] => {
    if (['Author', 'Editor', 'Translator'].includes(name)) return value.creators.filter(c => c.role === name.toLowerCase()).map(c => c.name.trim()).filter(Boolean);
    if (name === 'Identifier') return value.identifiers;
    const key = name.toLowerCase() as 'subtitle' | 'published' | 'publisher' | 'language' | 'cover';
    return value[key]?.trim() ? [value[key]!.trim()] : [];
  };
  const patches: { id: string; entries: string[]; values: string[] }[] = [];
  for (const [label, kind] of labels) {
    if (coverOnly ? label !== 'Cover' : label === 'Cover' && !onlyMissing) continue;
    let values = valuesFor(normalized, label);
    const old = valuesFor(previous, label);
    if (onlyMissing && old.length || JSON.stringify(old) === JSON.stringify(values)) continue;
    let field: FieldDefinition | undefined = currentFields.fields.find(field => field.name.toLowerCase() === label.toLowerCase());
    if (!field && !values.length) continue;
    if (!field) {
      const fieldsDoc = notebook.open(currentFields.page_id);
      try {
        await documentReady(fieldsDoc);
        const result = fieldsDoc.edit({ kind: 'addField', name: label, value: kind as FieldKind });
        if (!result.ok) throw new Error(result.reason);
        await fieldsDoc.flush();
        field = { id: result.created[0]!, name: label, kind, revision: 1, options: [] };
      } finally { fieldsDoc.release(); }
    }
    if (field.kind === 'instance') {
      values = await Promise.all(values.map(async value => {
        // An existing page with this exact title wins, comma and all; otherwise "Family, Given" names a new page "Given Family".
        const name = value.includes(',') ? value.split(',').reverse().map(s => s.trim()).join(' ') : value;
        const id = await notebook.pageByTitle(value, false) ?? await notebook.pageByTitle(name, true);
        if (!id) throw new Error('Could not create the creator page.');
        return `[[${id}]]`;
      }));
    } else if (field.kind === 'choice') {
      const definition = field;
      values = await Promise.all(values.map(async value => `[[${await addFieldOption(notebook, definition, value)}]]`));
    }
    patches.push({ id: field.id, entries: entries.get(label.toLowerCase()) ?? [], values });
  }
  const title = onlyMissing || coverOnly ? undefined : normalized.title!.trim();
  const result = doc.edit({ kind: 'sourceDetails', title, fields: patches });
  if (!result.ok) throw new Error(result.reason);
  await doc.flush();
  return patches.length + Number(title !== undefined && title !== previous.title);
}
