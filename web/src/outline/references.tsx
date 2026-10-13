import { Show, createResource, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { Menu } from '../ui/Menu';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import type { SourceRecord } from '../api/types';
import { ApiError } from '../api/client';
import { isStableReference, textTokens } from '../document/text-tokens';
import type { Token } from '../document/text-tokens';

/** A citation reference carries authored wording or a locator, not just a title. */
export function hasCitationDetail(token: Token): boolean {
  return isStableReference(token) && !!(token.alias || token.locator);
}

const sourceRecords = new WeakMap<NotebookClient, { sequence: number; records: Map<string, Promise<SourceRecord | null>> }>();
export function referenceSource(notebook: NotebookClient, id: string): Promise<SourceRecord | null> {
  const sequence = notebook.changeSequence();
  let cache = sourceRecords.get(notebook);
  if (!cache || cache.sequence !== sequence) {
    cache = { sequence, records: new Map() };
    sourceRecords.set(notebook, cache);
  }
  const existing = cache.records.get(id);
  if (existing) return existing;
  const request = notebook.api.capabilities(id).then(value => value.source ?? null).catch(error => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  cache.records.set(id, request);
  const records = cache.records;
  void request.catch(() => { if (records.get(id) === request) records.delete(id); });
  return request;
}

/** Shared capability reads keep static text, the editor and gutter in agreement. */
export function createCitationSources(notebook: NotebookClient, texts: () => readonly string[]) {
  const [records] = createResource(() => {
    const ids = [...new Set(texts().flatMap(text => textTokens(text).filter(hasCitationDetail).map(token => token.id!)))];
    return [ids, notebook.changeSequence()] as const;
  }, async ([ids]) => new Map((await Promise.all(ids.map(async id => {
    const target = notebook.lookup(id)();
    const source = target === null || target?.kind === 'block' ? null : await referenceSource(notebook, id);
    return [id, source] as const;
  }))).filter((entry): entry is readonly [string, SourceRecord] => entry[1] !== null)));
  return () => records.error ? undefined : records();
}


export function TypePill(props: {
  title: string;
  notebook: NotebookClient;
  onOpen?(target: OpenTarget, beside: boolean): void;
  onRemove?(): void;
  onRestoreFocus?(): void;
  start?: number;
  end?: number;
  children?: JSX.Element;
}) {
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const open = async (kind: 'table' | 'page') => {
    const id = await props.notebook.pageByTitle(props.title, false);
    if (id) props.onOpen?.(kind === 'page' ? { kind: 'page', pageId: id } : { kind: 'table', typeId: id, viewId: null, query: { type: id, text: null, filters: [], sort: [], limit: null } }, true);
  };
  return <>
    <button type="button" class="outline-tag" data-source-start={props.start} data-source-end={props.end}
      onClick={event => { event.stopPropagation(); setAnchor(event.currentTarget); }}>{props.children ?? `#${props.title}`}</button>
    <Show when={anchor()}>{element => <Menu anchor={element()} label={`#${props.title}`} onDismiss={() => { setAnchor(null); props.onRestoreFocus?.(); }} items={[
      { label: 'Open table', action: () => void open('table') },
      { label: 'Open type page', action: () => void open('page') },
      { label: 'Remove type', disabledReason: props.onRemove ? undefined : 'From the text. Edit the #tag there to remove it.', action: () => props.onRemove?.() },
    ]} />}</Show>
  </>;
}
