import { Show, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { QuoteStatus } from '../api/types';
import type { OpenTarget } from '../shell/contract';
import { quoteTarget } from '../document/text-tokens';
import { Button } from '../ui/Button';
import { createSettledChanges } from '../ui/loading';
import { BlockText } from './BlockText';
import { BlockTree } from './BlockTree';
import type { TreeRow } from './BlockTree';
import './quote.css';

/** One status read per page, not one request per visible quote. Text typing does not scan the outline. */
export function createQuoteStatus(doc: PageDocument, notebook: NotebookClient) {
  const hasQuotes = createMemo(() => {
    doc.outline.version();
    for (let index = 0; index < doc.outline.size(); index++) if (doc.block(doc.outline.idAt(index))?.quote) return true;
    return false;
  });
  const settled = createSettledChanges(notebook);
  let request: AbortController | undefined;
  onCleanup(() => request?.abort());
  const [status] = createResource(() => hasQuotes() && `${doc.pageId}:${settled()}:${notebook.connection() === 'live'}`, async () => {
    request?.abort();
    request = new AbortController();
    return notebook.api.quoteStatus(doc.pageId, request.signal);
  });
  return createMemo(() => new Map((status.error ? [] : status() ?? []).map(value => [value.block_id, value])));
}

export function Quote(props: {
  id: string;
  target: string;
  doc: PageDocument;
  notebook: NotebookClient;
  status?: QuoteStatus;
  onOpen(target: OpenTarget, beside: boolean): void;
}) {
  const block = () => props.doc.block(props.id);
  const quote = () => block()?.quote?.target_id === props.target ? block()!.quote : null;
  const source = () => props.notebook.lookup(props.target)();
  // Keep the last known page while mounted; snapshots deliberately contain no live page metadata.
  const sourcePageId = createMemo<string | undefined>(previous => source()?.page_id ?? previous);
  const page = () => sourcePageId() ? props.notebook.lookup(sourcePageId()!)() : undefined;
  const deleted = () => props.status?.source_live === false || source() === null;
  const rows = createMemo<TreeRow[]>(() => quote()?.rows.map(row => ({ id: row.id, depth: row.depth, role: 'body' })) ?? []);
  const frozen = createMemo(() => new Map(quote()?.rows.map(row => [row.id, row]) ?? []));
  const date = createMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: props.notebook.settings()?.time_zone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let disposed = false;
  onCleanup(() => { disposed = true; });
  async function capture() {
    if (busy()) return;
    const original = block();
    if (!original) return;
    const text = original.text, revision = original.revision, target = props.target;
    setBusy(true);
    setError('');
    try {
      const value = await props.notebook.api.quoteSnapshot(target);
      if (disposed) return;
      if (block()?.text !== text || block()?.revision !== revision || quoteTarget(text) !== target) throw new Error('The quote row changed. Capture again.');
      const result = props.doc.edit({ kind: 'quote', id: props.id, value });
      if (!result.ok) throw new Error(result.reason);
      await props.doc.flush();
    } catch (reason) {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!disposed) setBusy(false); }
  }
  function open(beside: boolean) {
    const target = source();
    if (target && !deleted()) props.onOpen({ kind: 'page', pageId: target.page_id, blockId: target.kind === 'block' ? target.id : undefined }, beside);
  }
  return <div class="outline-quote" aria-busy={busy()}>
    <Show when={quote()} fallback={<>
      <div class="outline-quote-frame"><Show when={source()} fallback={<span class="outline-quote-unresolved">Unresolved quote {props.target}</span>}>
        <BlockText text={source()?.text ?? ''} notebook={props.notebook} onOpen={props.onOpen} />
      </Show></div>
      <Show when={source() && !deleted()}><div class="outline-quote-rubric"><Button disabled={busy()} onClick={() => void capture()}>Capture quote</Button></div></Show>
    </>}>{captured => <>
      <div class="outline-quote-frame">
        <BlockTree rows={rows()} block={id => frozen().get(id)} notebook={props.notebook} onOpen={props.onOpen} />
        <Show when={captured().truncated}><p class="outline-quote-truncated">… truncated at capture</p></Show>
      </div>
      <div class="outline-quote-rubric">
        <span>QUOTE</span><span aria-hidden="true">·</span>
        <Show when={source() && !deleted()} fallback={<span>{page()?.text ?? 'Source deleted'}</span>}>
          <Button class="outline-quote-source" onClick={event => open(event.shiftKey)}>{page()?.text ?? source()?.text}</Button>
        </Show>
        <span aria-hidden="true">·</span><time dateTime={new Date(captured().captured_at).toISOString()}>{date().format(captured().captured_at)}</time>
        <Show when={deleted() && page()?.text}><span aria-hidden="true">·</span><span>Source deleted</span></Show>
        <Show when={!deleted() && props.status?.changed}><span aria-hidden="true">·</span><span>Source changed</span><Button disabled={busy()} onClick={() => void capture()}>Update</Button></Show>
      </div>
    </>}</Show>
    <Show when={error()}><p class="outline-capability-error" role="alert">{error()}</p></Show>
  </div>;
}
