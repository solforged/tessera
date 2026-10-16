import { For, Show } from 'solid-js';
import type { ApiClient } from '../api/client';
import type { CardRow, Citation, Passage, SourceView } from '../api/types';
import { followOn } from '../reader/sentences';

export interface ReviewSource {
  citation: Citation;
  source: SourceView;
  chapter: string | null;
  passages: Passage[];
  following: string;
}

/** Citation endpoints and passage slices use the same UTF-16 offsets as the reader. */
export async function reviewSource(api: ApiClient, row: CardRow): Promise<ReviewSource | null> {
  let block = row.source.block;
  let citation: Citation | undefined;
  const seen = new Set<string>();
  while (!seen.has(block.id)) {
    seen.add(block.id);
    citation = (await api.capabilities(block.id)).citations?.[0];
    if (citation) break;
    if (!block.parent_id || block.parent_id === block.page_id) return null;
    block = await api.block(block.parent_id);
  }
  if (!citation) return null;
  const source = await api.source(citation.source_id);
  let page = await api.passages(citation.snapshot_id, Math.max(0, citation.ordinal - 2), 12);
  const passages = [...page.passages];
  let end = passages.findIndex(passage => passage.id === citation.end.passage_id);
  while ((end < 0 || end === passages.length - 1) && passages.length && passages.at(-1)!.ordinal + 1 < page.total) {
    page = await api.passages(citation.snapshot_id, passages.at(-1)!.ordinal + 1, 12);
    if (!page.passages.length) break;
    passages.push(...page.passages);
    end = passages.findIndex(passage => passage.id === citation.end.passage_id);
  }
  const trailing = end < 0 ? '' : [passages[end]!.text.slice(citation.end.offset), ...passages.slice(end + 1).map(passage => passage.text)].join('\n\n').trim();
  const chapter = citation.chapter_title ?? page.toc.filter(entry => entry.ordinal !== null && entry.ordinal <= citation.ordinal).at(-1)?.title ?? null;
  return { citation, source, chapter, passages: passages.slice(0, end < 0 ? passages.length : end + 3), following: followOn(trailing) };
}

/** A quiet reading half, without reader navigation or edits. The answer waits for reveal. */
export function ReviewSourcePassage(props: { context: ReviewSource; revealed: boolean }) {
  const range = (passage: Passage) => {
    const citation = props.context.citation;
    const first = props.context.passages.findIndex(value => value.id === citation.start.passage_id);
    const last = props.context.passages.findIndex(value => value.id === citation.end.passage_id);
    const at = props.context.passages.indexOf(passage);
    return at < first || at > last ? null : { start: at === first ? citation.start.offset : 0, end: at === last ? citation.end.offset : passage.text.length };
  };
  return <aside class="review-source-passage" aria-label="Source passage">
    <header><span>{props.context.source.page.text}</span><Show when={props.context.chapter}><span>{props.context.chapter}</span></Show></header>
    <Show when={props.revealed} fallback={<p class="review-source-wait">Reveal the card to read its passage in context.</p>}>
      <For each={props.context.passages}>{passage => {
        const selected = range(passage);
        return <p classList={{ 'review-source-heading': passage.kind === 'heading' }}>{selected ? <>{passage.text.slice(0, selected.start)}<mark class={`review-source-highlight review-source-highlight-${props.context.citation.color ?? 'none'}`}>{passage.text.slice(selected.start, selected.end)}</mark>{passage.text.slice(selected.end)}</> : passage.text}</p>;
      }}</For>
    </Show>
  </aside>;
}
