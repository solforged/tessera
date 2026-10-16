import { opensBeside } from '../shell/beside';
import { For, Show, createMemo, createResource, createSignal, onCleanup, untrack } from 'solid-js';
import type { StreamArrival } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OpenTarget } from '../shell/contract';
import { Button } from '../ui/Button';
import { createSettledChanges } from '../ui/loading';
import { BlockText } from './BlockText';
import { addArrival, createAddedTargets, streamDay } from './streams';
import './streams.css';

export function Arrivals(props: {
  doc: PageDocument;
  notebook: NotebookClient;
  onOpen(target: OpenTarget, beside: boolean): void;
  onAdded(): void;
}) {
  const added = createAddedTargets(props.doc);
  const settled = createSettledChanges(props.notebook);
  const [candidates, setCandidates] = createSignal<StreamArrival[]>([]);
  const [error, setError] = createSignal('');
  let request: AbortController | undefined;
  onCleanup(() => request?.abort());
  const [read] = createResource(() => props.doc.root()?.revision === 0 ? false : `${settled()}:${props.notebook.connection() === 'live'}`, async () => {
    request?.abort();
    const current = request = new AbortController();
    const rows = await props.notebook.api.streamArrivals(props.doc.pageId, current.signal);
    if (current.signal.aborted) return;
    // Keep locally added candidates through acknowledgements, so undo restores
    // the arrival immediately rather than waiting for a server round trip.
    const targets = untrack(added);
    setCandidates(previous => [...rows, ...previous.filter(row => targets.has(row.block.id) && !rows.some(next => next.block.id === row.block.id))]);
  });
  const arrivals = createMemo(() => candidates().filter(row => !added().has(row.block.id)));
  const groups = createMemo(() => {
    const days = new Map<string, StreamArrival[]>();
    for (const row of arrivals()) {
      const day = days.get(row.page.text);
      if (day) day.push(row); else days.set(row.page.text, [row]);
    }
    return [...days].sort(([left], [right]) => right.localeCompare(left));
  });
  function Arrival(propsRow: { row: StreamArrival }) {
    const tree = props.notebook.watchSubtree(propsRow.row.block.id);
    onCleanup(tree.release);
    const block = () => tree.value() ? props.notebook.lookup(propsRow.row.block.id)() : propsRow.row.block;
    const children = () => Math.max(0, (tree.value()?.rows.length ?? 1) - 1);
    return <div class="stream-arrival" data-arrival-id={propsRow.row.block.id}>
      <div class="stream-arrival-text"><BlockText text={block()?.text ?? propsRow.row.block.text} blockId={propsRow.row.block.id} notebook={props.notebook} onOpen={props.onOpen} /></div>
      <Show when={children()}><span class="stream-fact">{children()}{tree.value()?.truncated ? '+' : ''} nested</span></Show>
      <Button onClick={() => { const result = addArrival(props.doc, propsRow.row.block.id); setError(result.ok ? '' : result.reason); if (result.ok) props.onAdded(); }}>Add</Button>
      <Show when={tree.error()}><span role="alert">{tree.error()}</span></Show>
    </div>;
  }
  return <>
    <Show when={arrivals().length}><section class="related-sections stream-arrivals" aria-label="Arrivals">
      <h2 class="stream-section-heading"><span>Arrivals</span><span class="section-rule" /><span>{arrivals().length}</span></h2>
      <For each={groups()}>{([day, rows]) => <div class="stream-day">
        <h3 class="stream-day-heading"><Button onClick={event => props.onOpen({ kind: 'page', pageId: rows[0]!.page.id }, opensBeside(event))}><time dateTime={day}>{streamDay(day)}</time></Button></h3>
        <For each={rows}>{row => <Arrival row={row} />}</For>
      </div>}</For>
    </section></Show>
    <Show when={read.error || error()}><p class="outline-capability-error" role="alert">{error() || String(read.error)}</p></Show>
  </>;
}
