import type { FieldDefinition } from '../api/types';
import type { BlockState, NotebookClient, PageDocument } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { fieldEntryId, matchFieldEntry } from '../table/query';

export function sourceFieldName(text: string, definitions: ReadonlyMap<string, FieldDefinition>): string | undefined {
  return definitions.get(fieldEntryId(text) ?? '')?.name ?? matchFieldEntry(text)?.name;
}

export function valueLabel(text: string, lookup: NotebookClient['lookup']): string {
  return textTokens(text).map(token => token.kind === 'reference' ? token.alias ?? lookup(token.id!)()?.text ?? token.id : token.value).join('');
}

export function sourceSummary(doc: PageDocument, definitions: ReadonlyMap<string, FieldDefinition>, lookup: NotebookClient['lookup']): string {
  const values: Record<string, string[]> = {};
  for (const id of doc.outline.children(doc.pageId)) {
    const entry = doc.block(id);
    if (!entry || entry.archived) continue;
    const name = sourceFieldName(entry.text, definitions)?.toLowerCase();
    if (name !== 'author' && name !== 'published' && name !== 'site') continue;
    const texts = doc.outline.children(id).flatMap(child => {
      const value = doc.block(child);
      return value && !value.archived ? [valueLabel(value.text, lookup)] : [];
    });
    if (!texts.length) {
      const inline = matchFieldEntry(entry.text)?.value;
      if (inline) texts.push(valueLabel(inline, lookup));
    }
    (values[name] ??= []).push(...texts);
  }
  const published = values.published?.[0];
  const year = published?.match(/\d{4}/)?.[0] ?? published;
  return [values.author?.join(', '), year, values.site?.join(', ')].filter(Boolean).join(' · ');
}

/** Reset extracted positions without discarding authored extra values. */
export function extractedResets(values: readonly Pick<BlockState, 'id' | 'text'>[], extracted: readonly string[] | undefined): { set: { id: string; text: string }[]; insert: string[] } {
  return {
    set: values.flatMap((value, index) => extracted?.[index] === undefined || value.text === extracted[index] ? [] : [{ id: value.id, text: extracted[index]! }]),
    insert: extracted?.slice(values.length) ?? [],
  };
}

/** Title before any subtitle colon, cut at a word boundary within 40 characters. */
export function shortSourceTitle(title: string): string {
  const main = title.split(':', 1)[0]!.trim();
  if (main.length <= 40) return main;
  const cut = main.slice(0, 40);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : 40).trimEnd()}…`;
}
