import { Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import { api, exportExtensions } from '../api/client';
import type { ExportFormat } from '../api/client';
import type { Citation, ReadingState } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OutlinePaneProps } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { downloadBlob } from '../ui/download';
import { ResourceImage } from '../library/ResourceImage';
import { formatProgress } from '../library/query';
import { shortSourceTitle } from './source';
import '../library/library.css';

const stateLabels: Record<ReadingState, string> = { inbox: 'Inbox', reading: 'Reading', finished: 'Finished', abandoned: 'Abandoned' };

export function SourceHeader(props: {
  doc: PageDocument; notebook: NotebookClient;
  onOpen: OutlinePaneProps['onOpen']; onError(message: string): void;
  resetItems(): MenuItem[];
}) {
  const [source] = createResource(() => props.notebook.changeSequence(), () => api.source(props.doc.pageId));
  const [menu, setMenu] = createSignal<{ anchor: HTMLElement; label: string; items: MenuItem[] } | null>(null);
  const snapshot = createMemo(() => source()?.snapshots.find(snapshot => snapshot.id === source()?.source.current_snapshot_id));
  const [expanded, setExpanded] = createSignal(false);
  const [overflows, setOverflows] = createSignal(false);
  const [descriptionElement, setDescriptionElement] = createSignal<HTMLParagraphElement>();
  createEffect(() => { snapshot()?.metadata.description; setExpanded(false); });
  createEffect(() => {
    const element = descriptionElement();
    snapshot()?.metadata.description;
    if (!element) { setOverflows(false); return; }
    const measure = () => setOverflows(element.scrollHeight > Number.parseFloat(getComputedStyle(element).lineHeight) * 3 + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    onCleanup(() => observer.disconnect());
  });
  const fail = (error: unknown) => props.onError(error instanceof Error ? error.message : String(error));
  function stateMenu(anchor: HTMLElement) {
    setMenu({ anchor, label: 'Reading state', items: (Object.keys(stateLabels) as ReadingState[]).map(state => ({
      label: stateLabels[state], icon: props.doc.root()?.source?.state === state ? 'check' : undefined,
      action: () => {
        const current = props.doc.root()?.source;
        if (!current) return;
        const result = props.doc.edit({ kind: 'source', id: props.doc.pageId, value: { ...current, state } });
        if (!result.ok) { fail(result.reason); return; }
        void props.doc.flush().catch(fail);
      },
    })) });
  }
  async function exportSource(format: ExportFormat) {
    try {
      const blob = await api.exportSources(format, [props.doc.pageId]);
      downloadBlob(blob, `${props.doc.root()?.source?.citation_key ?? props.doc.pageId}.${exportExtensions[format]}`);
    } catch (error) { fail(error); }
  }
  function sourceMenu(anchor: HTMLElement) {
    setMenu({ anchor, label: 'Source actions', items: [
      ...props.resetItems(),
      { label: 'Copy citation key', icon: 'copy', disabledReason: props.doc.root()?.source?.citation_key ? undefined : 'No citation key', action: () => { void navigator.clipboard.writeText(props.doc.root()!.source!.citation_key!).catch(fail); } },
      { label: 'Export BibTeX', icon: 'download', action: () => { void exportSource('bibtex'); } },
      { label: 'Export CSL JSON', icon: 'download', action: () => { void exportSource('csl'); } },
      { label: 'Export Markdown', icon: 'download', action: () => { void exportSource('markdown'); } },
      { label: 'Snapshots', icon: 'history', disabledReason: source.error ? String(source.error) : !source()?.snapshots.length ? 'No snapshots' : undefined,
        action: () => setMenu({ anchor, label: 'Snapshots', items: (source()?.snapshots ?? []).map(snapshot => ({
          label: `${new Date(snapshot.attached_at).toLocaleDateString()} · ${snapshot.passage_count} ${snapshot.passage_count === 1 ? 'passage' : 'passages'}`,
          action: () => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId, snapshotId: snapshot.id }, false),
        })) }) },
    ] });
  }
  return <>
    <div class="outline-source-header">
      <Show when={snapshot()?.metadata.cover}>{cover => <Button class="outline-source-cover" label="Read" onClick={event => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId }, event.shiftKey)}>
        <ResourceImage snapshotId={snapshot()!.id} href={cover()} loading="lazy" alt="" />
      </Button>}</Show>
      <div class="outline-source-info">
        <div class="outline-source-summary">
          <Show when={source()?.source.siglum}>{siglum => <span class="source-siglum" title="Siglum: add a Siglum field to change it">{siglum()}</span>}</Show>
          <span>{props.doc.root()!.source!.format === 'epub' ? 'EPUB' : 'Article'}</span>
          <Show when={!source.error && source() && source()!.progress > 0}><span class="outline-source-progress" aria-label="Reading position" title="Reading position">{formatProgress(source()!.progress)}</span></Show>
        </div>
        <div class="outline-source-actions">
          <Button aria-haspopup="menu" onClick={event => stateMenu(event.currentTarget)}>{stateLabels[props.doc.root()!.source!.state]}<Icon name="down" /></Button>
          <Button class="bordered" icon="book" onClick={event => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId }, event.shiftKey)}>Read</Button>
          <Button icon="more" label="Source actions" aria-haspopup="menu" onClick={event => sourceMenu(event.currentTarget)} />
        </div>
        <Show when={snapshot()?.metadata.description}>{description => <div class="outline-source-description">
          <p ref={setDescriptionElement} classList={{ expanded: expanded() }}>{description()}</p>
          <Show when={overflows()}><Button class="text-button" aria-expanded={expanded()} onClick={() => setExpanded(value => !value)}>{expanded() ? 'Less' : 'More'}</Button></Show>
        </div>}</Show>
      </div>
    </div>
    <Show when={source.error}><p class="outline-capability-error" role="alert">{String(source.error)}</p></Show>
    <Show when={menu()}>{state => <Menu {...state()} onDismiss={() => setMenu(null)} />}</Show>
  </>;
}

/** Short source title and passage number; opens the reader at the cited range. */
export function CitationChip(props: { citation: Citation; pageId: string; notebook: NotebookClient; onOpen: OutlinePaneProps['onOpen'] }) {
  const title = () => shortSourceTitle(props.notebook.lookup(props.citation.source_id)()?.text ?? 'Source');
  return <Button class={`outline-planning outline-citation${props.citation.source_id === props.pageId ? ' outline-citation-local' : ''}`} title={`Passage ${props.citation.ordinal + 1}${props.citation.chapter_title ? ` · ${props.citation.chapter_title}` : ''}`} onClick={event => props.onOpen({
    kind: 'reader', sourceId: props.citation.source_id, snapshotId: props.citation.snapshot_id,
    at: props.citation.start.passage_id, citationId: props.citation.id,
  }, event.shiftKey)}><span class={`highlight-color-dot highlight-color-${props.citation.color ?? 'none'}`} aria-hidden="true" /><span><Show when={props.citation.source_id !== props.pageId}>{title()} · </Show>¶{props.citation.ordinal + 1}</span></Button>;
}
