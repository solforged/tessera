import { For, Show, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import type { Block, Mention } from '../api/types';
import { api } from '../api/client';
import { loadWorks } from '../library/PersonWorks';
import type { OutlineIndex } from '../document/outline-index';
import { linkMentionEdit } from '../document/link-mention';
import { isStableReference, textTokens } from '../document/text-tokens';
import { documentReady } from '../tasks/JournalAgenda';
import { journalDayLabel } from '../tasks/journal-date';
import { BlockBreadcrumb, BlockText } from './BlockText';
import { plainText } from './names';
import { BacklinkSource, BlockReferenceCount } from './Backlinks';
import type { OutlineContext } from './context';
import { Button } from '../ui/Button';
import { createSettledChanges } from '../ui/loading';
import { isVirtualJournal, readJournalRelated } from './related-reads';

export function createOutlineRelated(context: Pick<OutlineContext, 'props' | 'doc' | 'zoom' | 'zoomTo' | 'localPositions'>) {
  const { props, doc, zoom, zoomTo, localPositions } = context;
  const [limit, setLimit] = createSignal(100);
  let relatedRequests: AbortController | undefined;
  let countRequest: AbortController | undefined;
  const relatedVersion = createSettledChanges(props.notebook);
  const version = () => `${props.pageId}:${relatedVersion()}:${props.notebook.connection() === 'live'}:${isVirtualJournal(doc.root())}`;
  onCleanup(() => { relatedRequests?.abort(); countRequest?.abort(); });
  const [counts] = createResource(version, async () => {
    countRequest?.abort();
    countRequest = new AbortController();
    return readJournalRelated(api.referenceCounts(props.pageId, countRequest.signal), doc.root(), []);
  });
  const countById = createMemo(() => new Map((counts.error ? [] : counts() ?? []).map(row => [row.block_id, row.count])));
  const [relatedResource] = createResource(() => `${version()}:${limit()}`, async () => {
    relatedRequests?.abort();
    const requests = relatedRequests = new AbortController();
    const [references, tagged, held, about] = await Promise.all([readJournalRelated(api.pageReferences(props.pageId, limit(), requests.signal), doc.root(), { total: 0, groups: [] }), api.members(props.pageId, undefined, requests.signal), api.positions({ holder: props.pageId }, requests.signal), api.positions({ subject: props.pageId }, requests.signal)]);
    // A position links its holder and often its subject, so it shows once, as a perspective, not again as a backlink.
    const positions = new Set([...held.rows, ...about.rows].map(row => row.block.block.id));
    const rootLinks = references.groups.flatMap(group => group.sources.filter(row => row.targets.includes(props.pageId)).map(row => ({ source: row.source, page: group.page })));
    const works = await loadWorks(api, props.pageId, rootLinks, requests.signal);
    let filtered = 0;
    const backlinks = references.groups.map(group => ({ ...group, sources: group.sources.filter(row => {
      if (!positions.has(row.source.id) && !works.creatorLinks.has(row.source.id)) return true;
      filtered++;
      return false;
    }) })).filter(group => group.sources.length);
    const loaded = references.groups.reduce((count, group) => count + group.sources.length, 0);
    return {
      works: works.rows,
      backlinks,
      total: references.total - filtered,
      remaining: references.total - loaded,
      tagged,
      held: held.rows.map(row => row.block),
      // Perspectives on this page filed elsewhere, such as under a highlight on a source page.
      about: about.rows.filter(row => row.block.page.id !== props.pageId).map(row => row.block),
      aboutHolders: about.rows.filter(row => row.block.page.id !== props.pageId).map(row => row.holder_id),
    };
  });
  const related = createMemo(() => relatedResource.error ? undefined : relatedResource());
  const relatedError = createMemo(() => relatedResource.error);
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
  function ReferenceCount(propsCount: { id: string }) {
    const count = () => propsCount.id === props.pageId ? 0 : countById().get(propsCount.id) ?? 0;
    return <Show when={count() > 0}><BlockReferenceCount id={propsCount.id} count={count()} version={relatedVersion()} notebook={props.notebook} onOpen={props.onOpen} /></Show>;
  }
  /** Blocks on this page a source names only through an alias; a plain reference already reads as its target. */
  const hiddenTargets = (text: string, targets: string[]) => {
    const aliased = new Set(textTokens(text).flatMap(token => isStableReference(token) && token.alias ? [token.id!] : []));
    return targets.filter(target => target !== props.pageId && aliased.has(target));
  };
  function Backlinks() {
    const [open, setOpen] = createSignal(true);
    const groups = createMemo(() => new Map((related()?.backlinks ?? []).map(group => [group.page.id, group])));
    const pages = createMemo(() => [...groups().keys()]);
    return <details class="related-section backlinks-section" open onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Backlinks <span>{relatedError() ? 'Unavailable' : relatedResource.loading && !related() ? 'Loading…' : related()?.total ?? 0}</span></summary>
      <Show when={open()}>
        <Show when={relatedError()}><p role="alert">Couldn't load backlinks.</p></Show>
        <For each={pages()}>{pageId => {
          const group = () => groups().get(pageId)!;
          const page = createMemo(() => props.notebook.lookup(pageId)() ?? group().page);
          const sources = createMemo(() => new Map(group().sources.map(row => [row.source.id, row])));
          const ids = createMemo(() => [...sources().keys()]);
          return <section class="backlink-group">
            <h3 class="backlink-group-heading"><Button role="link" onClick={event => props.onOpen({ kind: 'page', pageId }, event.shiftKey)}>{page().kind === 'journal' ? journalDayLabel(page().text) : page().text}</Button><span>{ids().length}</span></h3>
            <For each={ids()}>{id => <div class="backlink-entry">
              <BacklinkSource block={sources().get(id)!.source} page={group().page} notebook={props.notebook} onOpen={props.onOpen} />
              <For each={hiddenTargets(sources().get(id)!.source.text, sources().get(id)!.targets)}>{target => <Button class="backlink-target" onClick={() => zoomTo(target)}>→ {plainText(doc.block(target)?.text ?? props.notebook.lookup(target)()?.text ?? '', reference => props.notebook.lookup(reference)) || 'Empty block'}</Button>}</For>
            </div>}</For>
          </section>;
        }}</For>
        <Show when={(related()?.remaining ?? 0) > 0}><Button class="text-button" disabled={relatedResource.loading} onClick={() => setLimit(value => value + 100)}>Load more backlinks ({related()?.remaining} remaining)</Button></Show>
      </Show>
    </details>;
  }
  const mentionsAvailable = () => doc.root()?.kind === 'page' && !doc.root()?.archived && !!doc.root()?.text.trim() && doc.root()?.text.toLowerCase() !== 'fields';
  function UnlinkedMentions() {
    const [open, setOpen] = createSignal(false);
    const [busy, setBusy] = createSignal<string>();
    const [error, setError] = createSignal('');
    let request: AbortController | undefined;
    onCleanup(() => request?.abort());
    const [mentions, { refetch }] = createResource(() => open() ? version() : false, async () => {
      request?.abort();
      request = new AbortController();
      return api.unlinkedMentions(props.pageId, 100, request.signal);
    });
    const rows = createMemo(() => new Map((mentions.error ? [] : mentions()?.rows ?? []).map(row => [row.block.id, row])));
    const ids = createMemo(() => [...rows().keys()]);
    async function link(row: Mention) {
      if (busy()) return;
      setBusy(row.block.id); setError('');
      const source = props.notebook.open(row.page.id);
      try {
        await documentReady(source);
        const block = source.block(row.block.id);
        const edit = block && linkMentionEdit(block.id, block.text, props.pageId, row.term);
        if (!edit) throw new Error('This mention changed. Open its source to link it.');
        const result = source.edit(edit);
        if (!result.ok) throw new Error(result.reason);
        await source.flush();
        await refetch();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        source.release();
        setBusy(undefined);
      }
    }
    return <details class="related-section unlinked-mentions" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Unlinked mentions <Show when={mentions() !== undefined || mentions.error || mentions.loading}><span>{mentions.error ? 'Unavailable' : mentions()?.total ?? 'Loading…'}</span></Show></summary>
      <Show when={open()}>
        <Show when={mentions.error}><p role="alert">Couldn't load unlinked mentions.</p></Show>
        <Show when={error()}><p role="alert">{error()}</p></Show>
        <For each={ids()}>{id => {
          const row = () => rows().get(id)!;
          const live = props.notebook.lookup(id);
          return <div class="related-block mention-entry">
            <div class="mention-body"><Button class="mention-breadcrumb" onClick={event => props.onOpen({ kind: 'page', pageId: row().page.id, blockId: id }, event.shiftKey)}><BlockBreadcrumb block={live() ?? row().block} notebook={props.notebook} /></Button>
              <BlockText text={live()?.text ?? row().block.text} blockId={id} notebook={props.notebook} onOpen={props.onOpen} highlight={row().term} />
            </div>
            <Button class="text-button mention-link" disabled={!!busy()} onClick={() => void link(row())}>{busy() === id ? 'Linking…' : 'Link'}</Button>
          </div>;
        }}</For>
      </Show>
    </details>;
  }
  function Related(propsRelated: { title: string; rows: { block: Block; page: Block }[] }) {
    const [open, setOpen] = createSignal(false);
    return <details class="related-section" onToggle={event => setOpen(event.currentTarget.open)}><summary>{propsRelated.title} <span>{relatedError() ? 'Unavailable' : relatedResource.loading && !related() ? 'Loading…' : propsRelated.rows.length}</span></summary>
      <Show when={open()}>
      <Show when={!relatedError()} fallback={<p role="alert">Couldn't load related blocks.</p>}>
      <For each={propsRelated.rows}>{result => {
        const live = props.notebook.lookup(result.block.id);
        return <div class="related-block"><div class="related-open" role="link" tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, event.shiftKey); }} onClick={event => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, event.shiftKey)}>
          <span class="related-breadcrumb"><BlockBreadcrumb block={result.block} notebook={props.notebook} /></span>
          <BlockText text={live()?.text ?? result.block.text} notebook={props.notebook} interactive={false} />
        </div><button type="button" class="text-button" onClick={() => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, true)}>Open beside</button></div>;
      }}</For>
      </Show>
      </Show>
    </details>;
  }
  return { related, relatedError, apparatus, holders, linkedPages, Related, Backlinks, UnlinkedMentions, mentionsAvailable, ReferenceCount };
}
