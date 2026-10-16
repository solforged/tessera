import { besideHint, opensBeside } from '../shell/beside';
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import type { Block, Mention, ReferenceGroup } from '../api/types';
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
import { IncomingRelations } from './RelationLines';
import type { HolderRelation } from './Apparatus';
import { hasCitationDetail } from './source-reads';

export function createOutlineRelated(context: Pick<OutlineContext, 'props' | 'doc' | 'zoom' | 'zoomTo' | 'localPositions'>) {
  const { props, doc, zoom, zoomTo, localPositions } = context;
  const [limit, setLimit] = createSignal(100);
  let relatedRequests: AbortController | undefined;
  let countRequest: AbortController | undefined;
  const relatedVersion = createSettledChanges(props.notebook);
  const version = () => doc.root()?.kind === 'page' && doc.root()?.revision === 0 ? false
    : `${props.pageId}:${relatedVersion()}:${props.notebook.connection() === 'live'}:${isVirtualJournal(doc.root())}:${!!doc.root()?.question}`;
  const subjects = createMemo(() => {
    doc.outline.version(); doc.archivedVersion();
    const ids = [props.pageId];
    for (let at = 0; at < doc.outline.size(); at++) {
      const id = doc.outline.idAt(at);
      if (doc.block(id)?.question && !doc.isArchived(id)) ids.push(id);
    }
    return ids.join(',');
  });
  onCleanup(() => { relatedRequests?.abort(); countRequest?.abort(); });
  const [counts] = createResource(version, async () => {
    countRequest?.abort();
    countRequest = new AbortController();
    return readJournalRelated(api.referenceCounts(props.pageId, countRequest.signal), doc.root(), []);
  });
  const countById = createMemo(() => new Map((counts.error ? [] : counts() ?? []).map(row => [row.block_id, row.count])));
  const [relatedResource] = createResource(() => {
    const current = version();
    return current ? `${current}:${limit()}:${!!doc.root()?.source}:${subjects()}` : false;
  }, async () => {
    relatedRequests?.abort();
    const requests = relatedRequests = new AbortController();
    const sourcePage = !!doc.root()?.source;
    const [references, tagged, held, aboutSubjects, passages, branches] = await Promise.all([
      readJournalRelated(api.pageReferences(props.pageId, sourcePage ? Number.MAX_SAFE_INTEGER : limit(), requests.signal), doc.root(), { total: 0, groups: [] }),
      api.members(props.pageId, undefined, requests.signal),
      api.positions({ holder: props.pageId }, requests.signal),
      Promise.all(subjects().split(',').map(subject => api.positions({ subject }, requests.signal))),
      sourcePage ? api.highlights({ source_id: props.pageId, limit: Number.MAX_SAFE_INTEGER }, requests.signal) : undefined,
      doc.root()?.question ? api.questions({ parent: props.pageId }, requests.signal) : Promise.resolve([]),
    ]);
    const about = [...new Map(aboutSubjects.flatMap(result => result.rows).map(row => [row.block.block.id, row])).values()];
    // A position links its holder and often its subject, so it shows once, as a perspective, not again as a backlink.
    const positions = new Set([...held.rows, ...about].map(row => row.block.block.id));
    const branchIds = new Set(branches.map(row => row.block.block.id));
    const rootLinks = references.groups.flatMap(group => group.sources.filter(row => row.targets.includes(props.pageId)).map(row => ({ source: row.source, page: group.page })));
    const works = await loadWorks(api, props.pageId, rootLinks, requests.signal);
    let filtered = 0;
    let backlinks = references.groups.map(group => ({ ...group, sources: group.sources.filter(row => {
      if (sourcePage || !positions.has(row.source.id) && !works.creatorLinks.has(row.source.id) && !branchIds.has(row.source.id) && !branchIds.has(group.page.id)) return true;
      filtered++;
      return false;
    }) })).filter(group => group.sources.length);
    const loaded = references.groups.reduce((count, group) => count + group.sources.length, 0);
    const cited: ReferenceGroup[] = [];
    if (sourcePage) {
      const byPage = new Map<string, ReferenceGroup>();
      const passageIds = new Set(passages?.rows.map(row => row.block.block.id));
      const add = (page: Block, source: Block, targets: string[]) => {
        if (page.id === props.pageId) return;
        let group = byPage.get(page.id);
        if (!group) { group = { page, sources: [] }; byPage.set(page.id, group); }
        if (!group.sources.some(row => row.source.id === source.id)) group.sources.push({ source, targets });
      };
      backlinks = backlinks.map(group => ({ ...group, sources: group.sources.filter(row => {
        const citation = passageIds.has(row.source.id) || textTokens(row.source.text).some(token => hasCitationDetail(token) && token.id === props.pageId);
        if (citation) add(group.page, row.source, row.targets);
        return !citation;
      }) })).filter(group => group.sources.length);
      for (const row of passages?.rows ?? []) add(row.block.page, row.block.block, [props.pageId]);
      cited.push(...byPage.values());
    }
    const citationTotal = cited.reduce((count, group) => count + group.sources.length, 0);
    return {
      works: works.rows,
      backlinks,
      cited,
      citationTotal,
      total: sourcePage ? backlinks.reduce((count, group) => count + group.sources.length, 0) : references.total - filtered,
      remaining: sourcePage ? 0 : references.total - loaded,
      tagged,
      held: held.rows.map(row => row.block),
      heldReadings: held.rows,
      // Readings filed under this page or its inline questions, but authored on another page.
      about: about.filter(row => row.block.page.id !== props.pageId).map(row => row.block),
      aboutHolders: about.filter(row => row.block.page.id !== props.pageId).map(row => row.holder_id),
    };
  });
  const related = createMemo(() => relatedResource.error ? undefined : relatedResource());
  const relatedError = createMemo(() => relatedResource.error);
  const relatedLoading = createMemo(() => relatedResource.loading);
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
  /** Perspectives filed under this page, here or elsewhere: the endpoints the constellation may join. */
  const perspectives = createMemo(() => {
    const ids = new Set<string>();
    (doc.outline as OutlineIndex).each(0, doc.outline.size(), row => { if (doc.block(row.id)?.position?.subject_id === props.pageId && !doc.isArchived(row.id)) ids.add(row.id); });
    for (const row of related()?.about ?? []) ids.add(row.block.id);
    return ids;
  }, undefined, { equals: (a, b) => a.size === b.size && [...a].every(id => b.has(id)) });
  let relationRequest: AbortController | undefined;
  onCleanup(() => relationRequest?.abort());
  // One subject read joins this page's perspectives wherever they and their relations are written.
  const [relationRows] = createResource(() => apparatus() ? version() : false, async () => {
    relationRequest?.abort();
    relationRequest = new AbortController();
    return api.relations({ subject: props.pageId }, relationRequest.signal);
  });
  const holderRelations = createMemo(() => {
    const ids = perspectives(), seen = new Map<string, HolderRelation>();
    for (const row of relationRows.error ? [] : relationRows() ?? []) {
      const from = row.source.holder_id, to = row.target?.holder_id;
      if (row.problem || row.kind === 'answers' || !from || !to || from === to) continue;
      if (!ids.has(row.source.block.block.id) || !ids.has(row.target!.block.block.id)) continue;
      seen.set(`${from}:${to}:${row.kind}`, { from, to, kind: row.kind });
    }
    return [...seen.values()];
  });
  const linkedPages = createMemo(() => {
    const seen: string[] = [];
    for (const row of related()?.backlinks ?? []) if (row.page.id !== props.pageId && !holders().includes(row.page.id) && !seen.includes(row.page.id)) seen.push(row.page.id);
    return seen.slice(0, 12);
  });
  function ReferenceCount(propsCount: { id: string }) {
    const count = () => propsCount.id === props.pageId ? 0 : countById().get(propsCount.id) ?? 0;
    return <Show when={count() > 0}><BlockReferenceCount id={propsCount.id} count={count()} version={relatedVersion()} notebook={props.notebook} onOpen={props.onOpen} /></Show>;
  }
  function RowRelations(row: { id: string }) {
    return <IncomingRelations target={row.id} version={relatedVersion()} enabled={row.id === props.pageId || row.id === zoom() || (countById().get(row.id) ?? 0) > 0} notebook={props.notebook} onOpen={props.onOpen} />;
  }
  /** Blocks on this page a source names only through an alias; a plain reference already reads as its target. */
  const hiddenTargets = (text: string, targets: string[]) => {
    const aliased = new Set(textTokens(text).flatMap(token => isStableReference(token) && token.alias ? [token.id!] : []));
    return targets.filter(target => target !== props.pageId && aliased.has(target));
  };
  const [blockBacklinks] = createResource(() => zoom() && doc.block(zoom()!)?.revision !== 0 ? [zoom()!, relatedVersion(), limit()] as const : false,
    ([id, , count]) => api.backlinks(id, count));
  function Backlinks(section: { cited?: boolean }) {
    const [open, setOpen] = createSignal(true);
    const [shown, setShown] = createSignal(100);
    const scoped = () => !!zoom() && !section.cited;
    const all = () => (section.cited ? related()?.cited : related()?.backlinks) ?? [];
    const groups = createMemo(() => {
      if (scoped()) {
        const groups = new Map<string, { page: Block; sources: { source: Block; targets: string[] }[] }>();
        for (const row of blockBacklinks.error ? [] : blockBacklinks() ?? []) {
          const group = groups.get(row.page.id) ?? { page: row.page, sources: [] };
          group.sources.push({ source: row.source, targets: [zoom()!] });
          groups.set(row.page.id, group);
        }
        return groups;
      }
      let remaining = shown();
      return new Map(all().flatMap(group => {
        const sources = group.sources.slice(0, remaining);
        remaining = Math.max(0, remaining - sources.length);
        return sources.length ? [[group.page.id, { ...group, sources }] as const] : [];
      }));
    });
    const pages = createMemo(() => [...groups().keys()]);
    const total = () => section.cited ? related()?.citationTotal ?? 0 : related()?.total ?? 0;
    const remaining = () => Math.max(0, total() - shown());
    return <details class="related-section backlinks-section" open onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{section.cited ? 'Cited in' : zoom() ? 'Linked to this block' : 'Backlinks'} <span>{scoped() ? blockBacklinks.error ? 'Unavailable' : blockBacklinks()?.length ?? 'Loading…' : relatedError() ? 'Unavailable' : relatedResource.loading && !related() ? 'Loading…' : total()}</span></summary>
      <Show when={open()}>
        <Show when={scoped() ? blockBacklinks.error : relatedError()}><p role="alert">Couldn't load backlinks.</p></Show>
        <For each={pages()}>{pageId => {
          const group = () => groups().get(pageId)!;
          const page = createMemo(() => props.notebook.lookup(pageId)() ?? group().page);
          const sources = createMemo(() => new Map(group().sources.map(row => [row.source.id, row])));
          const ids = createMemo(() => [...sources().keys()]);
          return <section class="backlink-group">
            <h3 class="backlink-group-heading"><Button role="link" onClick={event => props.onOpen({ kind: 'page', pageId }, opensBeside(event))}>{page().kind === 'journal' ? journalDayLabel(page().text) : page().text}</Button><span>{ids().length}</span></h3>
            <For each={ids()}>{id => <div class="backlink-entry">
              <BacklinkSource block={sources().get(id)!.source} page={group().page} notebook={props.notebook} onOpen={props.onOpen} />
              <For each={hiddenTargets(sources().get(id)!.source.text, sources().get(id)!.targets)}>{target => <Button class="backlink-target" onClick={() => zoomTo(target)}>→ {plainText(doc.block(target)?.text ?? props.notebook.lookup(target)()?.text ?? '', reference => props.notebook.lookup(reference)) || 'Empty block'}</Button>}</For>
            </div>}</For>
          </section>;
        }}</For>
        <Show when={!scoped() && remaining() > 0}><Button class="text-button" disabled={relatedResource.loading} onClick={() => { setShown(value => value + 100); if (!section.cited && (related()?.remaining ?? 0) > 0) setLimit(value => value + 100); }}>Load more ({remaining()} remaining)</Button></Show>
        <Show when={scoped() && (blockBacklinks()?.length ?? 0) >= limit()}><Button class="text-button" disabled={blockBacklinks.loading} onClick={() => setLimit(value => value + 100)}>Load more backlinks</Button></Show>
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
            <div class="mention-body"><Button class="mention-breadcrumb" onClick={event => props.onOpen({ kind: 'page', pageId: row().page.id, blockId: id }, opensBeside(event))}><BlockBreadcrumb block={live() ?? row().block} notebook={props.notebook} /></Button>
              <BlockText text={live()?.text ?? row().block.text} blockId={id} notebook={props.notebook} onOpen={props.onOpen} highlight={row().term} />
            </div>
            <Button class="text-button mention-link" disabled={!!busy()} onClick={() => void link(row())}>{busy() === id ? 'Linking…' : 'Link'}</Button>
          </div>;
        }}</For>
      </Show>
    </details>;
  }
  function Related(propsRelated: { title: string; rows: { block: Block; page: Block }[]; relations?: boolean; revealId?: string; expanded?: boolean; onExpanded?(expanded: boolean): void }) {
    const [open, setOpen] = createSignal(false);
    const expanded = createMemo(() => propsRelated.expanded ?? open());
    const revealId = createMemo(() => propsRelated.rows.some(row => row.block.id === propsRelated.revealId) ? propsRelated.revealId : undefined);
    createEffect(() => { if (revealId()) { setOpen(true); propsRelated.onExpanded?.(true); } });
    return <details class="related-section" open={expanded()} onToggle={event => {
      const next = event.currentTarget.open;
      setOpen(next);
      if (next !== propsRelated.expanded) propsRelated.onExpanded?.(next);
    }}><summary>{propsRelated.title} <span>{relatedError() ? 'Unavailable' : relatedResource.loading && !related() ? 'Loading…' : propsRelated.rows.length}</span></summary>
      <Show when={expanded()}>
      <Show when={!relatedError()} fallback={<p role="alert">Couldn't load related blocks.</p>}>
      <For each={propsRelated.rows}>{result => {
        const live = props.notebook.lookup(result.block.id);
        return <div class="related-block" data-reading-id={propsRelated.relations ? result.block.id : undefined} data-open-page={result.page.id} data-open-block={result.block.id} data-open-label={result.page.text}><div class="related-open" role="link" tabIndex={0} title={`Open · ${besideHint}`} onKeyDown={event => { if (event.key === 'Enter') props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, opensBeside(event)); }} onClick={event => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, opensBeside(event))}>
          <span class="related-breadcrumb"><BlockBreadcrumb block={result.block} notebook={props.notebook} /></span>
          <BlockText text={live()?.text ?? result.block.text} notebook={props.notebook} interactive={false} />
        </div><Button class="backlink-beside" icon="panes" label="Open beside" title={`Open beside · ${besideHint}`} onClick={() => props.onOpen({ kind: 'page', pageId: result.page.id, blockId: result.block.id }, true)} /><Show when={propsRelated.relations}><IncomingRelations target={result.block.id} version={relatedVersion()} notebook={props.notebook} onOpen={props.onOpen} /></Show></div>;
      }}</For>
      </Show>
      </Show>
    </details>;
  }
  return { related, relatedError, relatedLoading, apparatus, holders, holderRelations, linkedPages, Related, Backlinks, UnlinkedMentions, mentionsAvailable, ReferenceCount, RowRelations };
}
