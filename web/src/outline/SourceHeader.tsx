import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import { api, exportExtensions } from '../api/client';
import type { ExportFormat } from '../api/client';
import type { Citation, FieldDefinition, ReadingState } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OutlinePaneProps } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { formatProgress } from '../library/query';
import { shortSourceTitle, sourceSummary } from './source';
import '../library/library.css';

const stateLabels: Record<ReadingState, string> = { inbox: 'Inbox', reading: 'Reading', finished: 'Finished', abandoned: 'Abandoned' };

export function SourceHeader(props: {
  doc: PageDocument; notebook: NotebookClient; definitions: ReadonlyMap<string, FieldDefinition>;
  onOpen: OutlinePaneProps['onOpen']; onError(message: string): void;
  resetItems(): MenuItem[];
}) {
  const [source] = createResource(() => props.notebook.changeSequence(), () => api.source(props.doc.pageId));
  const [menu, setMenu] = createSignal<{ anchor: HTMLElement; label: string; items: MenuItem[] } | null>(null);
  const summary = createMemo(() => sourceSummary(props.doc, props.definitions, id => props.notebook.lookup(id)));
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
  function exportSource(format: ExportFormat) {
    const link = document.createElement('a');
    link.href = api.exportUrl(format, [props.doc.pageId]);
    link.download = `${props.doc.root()?.source?.citation_key ?? props.doc.pageId}.${exportExtensions[format]}`;
    link.click();
  }
  function sourceMenu(anchor: HTMLElement) {
    setMenu({ anchor, label: 'Source actions', items: [
      ...props.resetItems(),
      { label: 'Copy citation key', icon: 'copy', disabledReason: props.doc.root()?.source?.citation_key ? undefined : 'No citation key', action: () => { void navigator.clipboard.writeText(props.doc.root()!.source!.citation_key!).catch(fail); } },
      { label: 'Export BibTeX', icon: 'download', action: () => exportSource('bibtex') },
      { label: 'Export CSL JSON', icon: 'download', action: () => exportSource('csl') },
      { label: 'Export Markdown', icon: 'download', action: () => exportSource('markdown') },
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
        <img src={api.resourceUrl(snapshot()!.id, cover())} loading="lazy" alt="" />
      </Button>}</Show>
      <span class="outline-source-summary">
        <Show when={source()?.source.siglum}>{siglum => <span class="source-siglum" title="Siglum: add a Siglum field to change it">{siglum()}</span>}</Show>
        <For each={summary()}>{(part, index) => <>
          {index() > 0 ? ' · ' : ''}<Show when={part.url} fallback={part.text}>
            <a class="reference-url" href={part.url} target="_blank" rel="noopener noreferrer" onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>{part.text}</a>
          </Show>
        </>}</For>
      </span>
      <Show when={snapshot()?.metadata.description}>{description => <div class="outline-source-description">
        <p ref={setDescriptionElement} classList={{ expanded: expanded() }}>{description()}</p>
        <Show when={overflows()}><Button class="text-button" aria-expanded={expanded()} onClick={() => setExpanded(value => !value)}>{expanded() ? 'Less' : 'More'}</Button></Show>
      </div>}</Show>
      <div class="outline-source-actions">
        <Button class="bordered" aria-haspopup="menu" onClick={event => stateMenu(event.currentTarget)}>{stateLabels[props.doc.root()!.source!.state]}<Icon name="down" /></Button>
        <Show when={!source.error && source() && source()!.progress > 0}><span class="outline-source-progress" aria-label="Reading progress">{formatProgress(source()!.progress)} read</span></Show>
        <Button icon="book" onClick={event => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId }, event.shiftKey)}>Read</Button>
        <Button icon="more" label="Source actions" aria-haspopup="menu" onClick={event => sourceMenu(event.currentTarget)} />
      </div>
    </div>
    <Show when={source.error}><p class="outline-capability-error" role="alert">{String(source.error)}</p></Show>
    <Show when={menu()}>{state => <Menu {...state()} onDismiss={() => setMenu(null)} />}</Show>
  </>;
}

/** Short source title and passage number; opens the reader at the cited range. */
export function CitationChip(props: { citation: Citation; pageId: string; notebook: NotebookClient; onOpen: OutlinePaneProps['onOpen'] }) {
  const title = () => shortSourceTitle(props.notebook.lookup(props.citation.source_id)()?.text ?? 'Source');
  return <Button class={`outline-planning outline-citation${props.citation.source_id === props.pageId ? ' outline-citation-local' : ''}`} title={`Passage ${props.citation.ordinal + 1} · ${props.citation.locator}`} onClick={event => props.onOpen({
    kind: 'reader', sourceId: props.citation.source_id, snapshotId: props.citation.snapshot_id,
    at: props.citation.start.passage_id, citationId: props.citation.id,
  }, event.shiftKey)}><Show when={props.citation.color} fallback={<Icon name="quote" />}>{color => <span class={`highlight-color-dot highlight-color-${color()}`} aria-hidden="true" />}</Show><span><Show when={props.citation.source_id !== props.pageId}>{title()} · </Show>¶{props.citation.ordinal + 1}</span></Button>;
}
