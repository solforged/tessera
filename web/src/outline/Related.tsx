import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import type { Block } from '../api/types';
import { api } from '../api/client';
import { loadWorks } from '../library/PersonWorks';
import type { OutlineIndex } from '../document/outline-index';
import { BlockBreadcrumb, BlockText } from './BlockText';
import type { OutlineContext } from './context';

export function createOutlineRelated(context: Pick<OutlineContext, 'props' | 'doc' | 'zoom' | 'localPositions'>) {
  const { props, doc, zoom, localPositions } = context;
  const [relatedOpen, setRelatedOpen] = createSignal(new Set<string>());
  const [relatedVersion, setRelatedVersion] = createSignal(0);
  let relatedTimer: number | undefined;
  createEffect(() => {
    props.notebook.changeSequence();
    window.clearTimeout(relatedTimer);
    if (!relatedOpen().size) return;
    relatedTimer = window.setTimeout(() => setRelatedVersion(value => value + 1), 500);
  });
  onCleanup(() => window.clearTimeout(relatedTimer));
  const [related] = createResource(() => `${props.pageId}:${relatedVersion()}`, async () => {
    const [backlinks, tagged, held, about] = await Promise.all([api.backlinks(props.pageId), api.members(props.pageId), api.positions({ holder: props.pageId }), api.positions({ subject: props.pageId })]);
    // A position links its holder and often its subject, so it shows once, as a perspective, not again as a backlink.
    const positions = new Set([...held, ...about].map(row => row.block.block.id));
    const works = await loadWorks(api, props.pageId, backlinks);
    return {
      works: works.rows,
      backlinks: backlinks.filter(item => !positions.has(item.source.id) && !works.creatorLinks.has(item.source.id)).map(item => ({ block: item.source, page: item.page })),
      tagged,
      held: held.map(row => row.block),
      // Perspectives on this page filed elsewhere, such as under a highlight on a source page.
      about: about.filter(row => row.block.page.id !== props.pageId).map(row => row.block),
      aboutHolders: about.filter(row => row.block.page.id !== props.pageId).map(row => row.holder_id),
    };
  });
  /** Holders of the perspectives filed under this page, here or elsewhere, each once, in page order. */
  const holders = createMemo(() => {
    const seen: string[] = [];
    const add = (id: string | null | undefined) => { if (id && id !== props.pageId && !seen.includes(id)) seen.push(id); };
    (doc.outline as OutlineIndex).each(0, doc.outline.size(), row => { const position = doc.block(row.id)?.position; if (position?.subject_id === props.pageId) add(position.holder_id); });
    for (const id of related()?.aboutHolders ?? []) add(id);
    return seen;
  }, undefined, { equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]) });
  // The margin appears on titled pages with three or more perspectives; CSS shows it only when the pane is wide.
  const apparatus = () => doc.root()?.kind === 'page' && !zoom() && localPositions() + (related()?.aboutHolders.length ?? 0) >= 3;
  const linkedPages = createMemo(() => {
    const seen: string[] = [];
    for (const row of related()?.backlinks ?? []) if (row.page.id !== props.pageId && !holders().includes(row.page.id) && !seen.includes(row.page.id)) seen.push(row.page.id);
    return seen.slice(0, 12);
  });
  function Related(propsRelated: { title: string; rows: { block: Block; page: Block }[] }) {
    return <details class="related-section" onToggle={event => setRelatedOpen(previous => {
      const next = new Set(previous);
      event.currentTarget.open ? next.add(propsRelated.title) : next.delete(propsRelated.title);
      return next;
    })}><summary>{propsRelated.title} <span>{related.error ? 'Unavailable' : related.loading && !related() ? 'Loading…' : propsRelated.rows.length}</span></summary>
      <Show when={!related.error} fallback={<p role="alert">Couldn't load related blocks.</p>}>
      <For each={propsRelated.rows}>{result => {
        const live = props.notebook.lookup(result.block.id);
        return <div class="related-block"><div class="related-open" role="link" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, event.shiftKey); }} onClick={event => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, event.shiftKey)}>
          <span class="related-breadcrumb"><BlockBreadcrumb block={result.block} notebook={props.notebook} /></span>
          <BlockText text={live()?.text ?? result.block.text} notebook={props.notebook} onOpen={props.onOpen} />
        </div><button type="button" class="text-button" onClick={() => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, true)}>Open beside</button></div>;
      }}</For>
      </Show>
    </details>;
  }
  return { related, apparatus, holders, linkedPages, Related };
}
