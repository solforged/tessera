import { createEffect, createMemo, createResource, createRoot, createSignal, on, type Accessor } from 'solid-js';
import type { Block, ChangeEvent, FieldDefinition, SourceFormat } from '../api/types';
import type { IconName } from '../ui/Icon';
import type { BlockState, NotebookClient } from '../document/contract';
import { plainText, referenceValue } from './names';
import { textTokens } from '../document/text-tokens';
import { fieldEntryId, matchFieldEntry } from '../table/query';
import { isoLanguageNames } from '../library/languages';

export function sourceFieldName(text: string, definitions: ReadonlyMap<string, FieldDefinition>): string | undefined {
  return definitions.get(fieldEntryId(text) ?? '')?.name ?? matchFieldEntry(text)?.name;
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** Source details are formatted for display only; stored and edited values stay raw. */
export function formatSourceValue(name: string, value: string): string {
  if (name.toLowerCase() === 'language') {
    try {
      const label = languageNames.of(value);
      return !label || label.toLowerCase() === value.toLowerCase() ? isoLanguageNames[value.toLowerCase()] ?? value : label;
    } catch { return value; }
  }
  if (name.toLowerCase() === 'identifier') return value.replace(/^(isbn|doi):(.+)$/i, (_, kind: string, identifier: string) => `${kind.toUpperCase()} ${identifier}`);
  return value;
}

export function valueLabel(text: string, lookup: NotebookClient['lookup']): string {
  return textTokens(text).map(token => {
    if (token.kind !== 'reference') return token.value;
    const reference = referenceValue(token.value);
    return reference.id ? plainText(token.value, lookup) : reference.name;
  }).join('');
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

type SourceFormats = Accessor<ReadonlyMap<string, SourceFormat> | undefined>;
const sourceFormatMaps = new WeakMap<NotebookClient, SourceFormats>();

/** A change can add, drop or reformat a source only through a page the map hasn't seen, a removal, or a changed source capability. */
export function changeTouchesSources(event: ChangeEvent, formats: ReadonlyMap<string, SourceFormat>): boolean {
  return event.blocks.some(block => block.kind === 'page' && !formats.has(block.id))
    || event.removed.some(id => formats.has(id))
    || (event.capabilities ?? []).some(value => value.source !== undefined && (value.source?.format ?? null) !== (formats.get(value.block_id) ?? null));
}

/** Every page icon reads one shared Sources index instead of each page's capabilities, so a long list costs one request. */
function sourceFormats(notebook: NotebookClient): SourceFormats {
  const cached = sourceFormatMaps.get(notebook);
  if (cached) return cached;
  const formats = createRoot(() => {
    const [version, setVersion] = createSignal(0);
    const [index] = createResource(version, () => notebook.api.kindNotes('source'));
    const map = createMemo(() => {
      if (index.error) return undefined;
      const value = index.latest;
      return value && new Map(value.notes.flatMap(note => {
        const format = value.summaries[note.id]?.source?.format;
        return format ? [[note.id, format] as const] : [];
      }));
    });
    // `on` tracks only the change, so the refreshed map can't re-trigger its own reload; a later unrelated change keeps a scheduled one.
    let scheduled = false;
    createEffect(on(() => notebook.lastChange(), event => {
      if (!event || scheduled) return;
      const current = map();
      if (!index.error && (!current || !changeTouchesSources(event, current))) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; setVersion(value => value + 1); }, 300);
    }));
    return map;
  });
  sourceFormatMaps.set(notebook, formats);
  return formats;
}

/** The same source-aware identity in navigation, Find and reference suggestions. */
export function createPageIcon(notebook: NotebookClient, block: Accessor<Block>, enabled: Accessor<boolean> = () => true, journal: IconName = 'calendar'): Accessor<IconName> {
  const formats = sourceFormats(notebook);
  return () => {
    const kind = block().kind;
    if (kind === 'journal') return journal;
    if (kind === 'block') return 'bullet';
    const format = enabled() ? formats()?.get(block().id) : undefined;
    return format === undefined ? 'page' : format === 'article' ? 'article' : 'book';
  };
}

/** Whether a page is a work: a source, whose name is set in italics wherever it is named. Reads the same shared Sources index as page icons. */
export function createWorkTest(notebook: NotebookClient): (pageId: string) => boolean {
  const formats = sourceFormats(notebook);
  return pageId => formats()?.has(pageId) ?? false;
}
