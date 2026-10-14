import { createEffect, createMemo, createResource, createRoot, createSignal, on, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { NotebookClient } from '../document/contract';
import type { BlockCapabilities, ChangeEvent, SourceRecord } from '../api/types';
import { ApiError } from '../api/client';
import { isStableReference, textTokens } from '../document/text-tokens';
import type { Token } from '../document/text-tokens';

/** A citation reference carries authored wording or a locator, not just a title. */
export function hasCitationDetail(token: Token): boolean {
  return isStableReference(token) && !!(token.alias || token.locator);
}

interface Read {
  request: Promise<BlockCapabilities | null>;
  /** The change sequence this window had observed when the request went out; the reply reflects at least that. */
  sequence: number;
  /** Until the reply arrives, a read may hold a source. */
  source: boolean;
  /** Sources the block's citations quote. */
  quoted: readonly string[];
}
interface Reads { entries: Map<string, Read>; version: Accessor<number>; drop(stale: (id: string, read: Read) => boolean): void }

const notebookReads = new WeakMap<NotebookClient, Reads>();

/**
 * Whether a change can alter a cached read. A source's record derives from its own title, the fields on its
 * page and the titles of creator pages its fields link, so a change to a page root drops every cached source.
 * Sigla collisions need no wider rule: the service derives each source's siglum on its own, and `pageSigla`
 * extends colliding marks over the current records, so retitling or deleting one source only refreshes that
 * source and every list showing it recomputes from there.
 */
function staleAfter(event: ChangeEvent): (id: string, read: Read) => boolean {
  // A receipt stored before the service recorded touched pages could have touched anything.
  if (!event.pages) return (_, read) => read.sequence < event.seq;
  const ids = new Set([...event.blocks.map(block => block.id), ...event.removed, ...(event.capabilities ?? []).map(value => value.block_id)]);
  const pages = new Set([...event.pages, ...event.restructured_pages, ...event.blocks.map(block => block.page_id)]);
  const touches = (target: string) => ids.has(target) || pages.has(target);
  const roots = event.blocks.some(block => block.kind !== 'block');
  return (id, read) => read.sequence < event.seq && (touches(id) || read.quoted.some(touches) || read.source && roots);
}

function notebookCache(notebook: NotebookClient): Reads {
  const cached = notebookReads.get(notebook);
  if (cached) return cached;
  const entries = new Map<string, Read>();
  const [version, setVersion] = createSignal(0);
  const drop = (stale: (id: string, read: Read) => boolean) => {
    let dropped = false;
    for (const [id, read] of entries) if (stale(id, read)) { entries.delete(id); dropped = true; }
    if (dropped) setVersion(value => value + 1);
  };
  const reads: Reads = { entries, version, drop };
  let observed = untrack(() => notebook.changeSequence());
  createRoot(() => {
    createEffect(on(() => notebook.lastChange(), event => {
      if (!event) return;
      observed = Math.max(observed, event.seq);
      drop(staleAfter(event));
    }, { defer: true }));
    // A reload moves the sequence with no event to say what changed. Own receipts move it just before their event, in the same task.
    createEffect(on(() => notebook.changeSequence(), () => queueMicrotask(() => {
      const sequence = untrack(() => notebook.changeSequence());
      if (sequence <= observed) return;
      observed = sequence;
      drop(() => true);
    }), { defer: true }));
  });
  notebookReads.set(notebook, reads);
  return reads;
}

/** Changes whenever a cached read is dropped; resources built on these reads key on it instead of every change. */
export function sourceReadsVersion(notebook: NotebookClient): number {
  return notebookCache(notebook).version();
}

function capabilityRead(notebook: NotebookClient, id: string): Promise<BlockCapabilities | null> {
  const { entries } = notebookCache(notebook);
  const existing = entries.get(id);
  if (existing) return existing.request;
  const request = notebook.api.capabilities(id).catch(error => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  const read: Read = { request, sequence: untrack(() => notebook.changeSequence()), source: true, quoted: [] };
  entries.set(id, read);
  request.then(value => {
    read.source = !!value?.source;
    read.quoted = [...new Set((value?.citations ?? []).map(citation => citation.source_id))];
  }, () => { if (entries.get(id) === read) entries.delete(id); });
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

/** The source each ID cites, in the given order for `citedSigla`; empty while loading or after a failed read. */
export function createCitedSources(notebook: NotebookClient, ids: Accessor<readonly string[]>): Accessor<{ id: string; source: SourceRecord | null }[]> {
  const key = createMemo(() => ids().join('\u0000'));
  const [records] = createResource(() => key() ? { ids: untrack(ids), version: sourceReadsVersion(notebook) } : false, ({ ids }) =>
    Promise.all(ids.map(async id => ({ id, source: await citedSource(notebook, id).catch(() => null) }))));
  return () => key() && !records.error ? records() ?? [] : [];
}

/** Shared capability reads keep static text, the editor and gutter in agreement. */
export function createCitationSources(notebook: NotebookClient, texts: () => readonly string[], includeBare: () => boolean = () => false) {
  const [records] = createResource(() => {
    const ids = [...new Set(texts().flatMap(text => textTokens(text).filter(token => includeBare() ? isStableReference(token) : hasCitationDetail(token)).map(token => token.id!)))];
    return [ids, sourceReadsVersion(notebook)] as const;
  }, async ([ids]) => new Map((await Promise.all(ids.map(async id => {
    const target = notebook.lookup(id)();
    const source = target === null || target?.kind === 'block' ? null : await referenceSource(notebook, id);
    return [id, source] as const;
  }))).filter((entry): entry is readonly [string, SourceRecord] => entry[1] !== null)));
  return () => records.error ? undefined : records();
}
