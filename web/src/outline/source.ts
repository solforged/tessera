import { createResource, type Accessor } from 'solid-js';
import type { Block, FieldDefinition } from '../api/types';
import type { IconName } from '../ui/Icon';
import type { BlockState, NotebookClient } from '../document/contract';
import { textTokens } from '../document/text-tokens';
import { fieldEntryId, matchFieldEntry } from '../table/query';

export function sourceFieldName(text: string, definitions: ReadonlyMap<string, FieldDefinition>): string | undefined {
  return definitions.get(fieldEntryId(text) ?? '')?.name ?? matchFieldEntry(text)?.name;
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** Source details are formatted for display only; stored and edited values stay raw. */
export function formatSourceValue(name: string, value: string): string {
  if (name.toLowerCase() === 'language') {
    try { return languageNames.of(value) ?? value; } catch { return value; }
  }
  if (name.toLowerCase() === 'identifier') return value.replace(/^(isbn|doi):(.+)$/i, (_, kind: string, identifier: string) => `${kind.toUpperCase()} ${identifier}`);
  return value;
}

export function valueLabel(text: string, lookup: NotebookClient['lookup']): string {
  return textTokens(text).map(token => token.kind === 'reference' ? token.alias ?? lookup(token.id!)()?.text ?? token.id : token.value).join('');
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

/** The same source-aware identity in navigation, Find and reference suggestions. */
export function createPageIcon(notebook: NotebookClient, block: Accessor<Block>, enabled: Accessor<boolean> = () => true, journal: IconName = 'calendar'): Accessor<IconName> {
  const [capabilities] = createResource(() => enabled() && block().kind === 'page' ? block().id : false, id => notebook.api.capabilities(id));
  return () => block().kind === 'journal' ? journal : block().kind === 'block' ? 'bullet'
    : capabilities.error || !capabilities()?.source ? 'page' : capabilities()!.source!.format === 'article' ? 'article' : 'book';
}
