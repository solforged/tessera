import { Show, createResource, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { Menu } from '../ui/Menu';
import type { NotebookClient } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import type { BlockCapabilities, SourceRecord } from '../api/types';
import { ApiError } from '../api/client';
import { isStableReference, textTokens } from '../document/text-tokens';
import type { Token } from '../document/text-tokens';

/** A citation reference carries authored wording or a locator, not just a title. */
export function hasCitationDetail(token: Token): boolean {
  return isStableReference(token) && !!(token.alias || token.locator);
}

const capabilityReads = new WeakMap<NotebookClient, { sequence: number; reads: Map<string, Promise<BlockCapabilities | null>> }>();
function capabilityRead(notebook: NotebookClient, id: string): Promise<BlockCapabilities | null> {
  const sequence = notebook.changeSequence();
  let cache = capabilityReads.get(notebook);
  if (!cache || cache.sequence !== sequence) {
    cache = { sequence, reads: new Map() };
    capabilityReads.set(notebook, cache);
  }
  const existing = cache.reads.get(id);
  if (existing) return existing;
  const request = notebook.api.capabilities(id).catch(error => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  cache.reads.set(id, request);
  const reads = cache.reads;
  void request.catch(() => { if (reads.get(id) === request) reads.delete(id); });
  return request;
}

export function referenceSource(notebook: NotebookClient, id: string): Promise<SourceRecord | null> {
  return capabilityRead(notebook, id).then(value => value?.source ?? null);
}

/** The source a Work or citation names: the source page itself, or the source its referenced highlight quotes. */
export async function citedSource(notebook: NotebookClient, id: string): Promise<SourceRecord | null> {
  const value = await capabilityRead(notebook, id);
  if (value?.source) return value.source;
  const quoted = value?.citations?.[0]?.source_id;
  return quoted ? referenceSource(notebook, quoted) : null;
}

/** Shared capability reads keep static text, the editor and gutter in agreement. */
export function createCitationSources(notebook: NotebookClient, texts: () => readonly string[], includeBare: () => boolean = () => false) {
  const [records] = createResource(() => {
    const ids = [...new Set(texts().flatMap(text => textTokens(text).filter(token => includeBare() ? isStableReference(token) : hasCitationDetail(token)).map(token => token.id!)))];
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
