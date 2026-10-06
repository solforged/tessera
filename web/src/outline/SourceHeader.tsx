import { For, Show, createMemo, createResource, createSignal } from 'solid-js';
import { api } from '../api/client';
import type { Citation, FieldDefinition, ReadingState } from '../api/types';
import type { NotebookClient, PageDocument } from '../document/contract';
import type { OutlinePaneProps } from '../shell/contract';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Menu';
import type { MenuItem } from '../ui/Menu';
import { formatProgress } from '../library/query';
import { shortSourceTitle, sourceSummary } from './source';

const stateLabels: Record<ReadingState, string> = { inbox: 'Inbox', reading: 'Reading', finished: 'Finished', abandoned: 'Abandoned' };

export function SourceHeader(props: {
  doc: PageDocument; notebook: NotebookClient; definitions: ReadonlyMap<string, FieldDefinition>;
  onOpen: OutlinePaneProps['onOpen']; onError(message: string): void;
  resetItems(): MenuItem[];
}) {
  const [source] = createResource(() => props.notebook.changeSequence(), () => api.source(props.doc.pageId));
  const [menu, setMenu] = createSignal<{ anchor: HTMLElement; label: string; items: MenuItem[] } | null>(null);
  const summary = createMemo(() => sourceSummary(props.doc, props.definitions, id => props.notebook.lookup(id)));
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
  function exportSource(format: 'bibtex' | 'csl') {
    const link = document.createElement('a');
    link.href = api.exportUrl(format, [props.doc.pageId]);
    link.download = `${props.doc.root()?.source?.citation_key ?? props.doc.pageId}.${format === 'bibtex' ? 'bib' : 'json'}`;
    link.click();
  }
  function sourceMenu(anchor: HTMLElement) {
    setMenu({ anchor, label: 'Source actions', items: [
      ...props.resetItems(),
      { label: 'Copy citation key', icon: 'copy', disabledReason: props.doc.root()?.source?.citation_key ? undefined : 'No citation key', action: () => { void navigator.clipboard.writeText(props.doc.root()!.source!.citation_key!).catch(fail); } },
      { label: 'Export BibTeX', icon: 'download', action: () => exportSource('bibtex') },
      { label: 'Export CSL JSON', icon: 'download', action: () => exportSource('csl') },
      { label: 'Snapshots', disabledReason: source.error ? String(source.error) : !source()?.snapshots.length ? 'No snapshots' : undefined,
        action: () => setMenu({ anchor, label: 'Snapshots', items: (source()?.snapshots ?? []).map(snapshot => ({
          label: `${new Date(snapshot.attached_at).toLocaleDateString()} · ${snapshot.passage_count} ${snapshot.passage_count === 1 ? 'passage' : 'passages'}`,
          action: () => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId, snapshotId: snapshot.id }, false),
        })) }) },
    ] });
  }
  return <>
    <div class="outline-source-header">
      <Show when={summary().length}><span class="outline-source-summary"><For each={summary()}>{(part, index) => <>
        {index() > 0 ? ' · ' : ''}<Show when={part.url} fallback={part.text}>
          <a class="reference-url" href={part.url} target="_blank" rel="noopener noreferrer" onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>{part.text}</a>
        </Show>
      </>}</For></span></Show>
      <Button class="bordered" aria-haspopup="menu" onClick={event => stateMenu(event.currentTarget)}>{stateLabels[props.doc.root()!.source!.state]}<Icon name="down" /></Button>
      <Show when={!source.error && source() && source()!.progress > 0}><span class="outline-source-progress" aria-label="Reading progress">{formatProgress(source()!.progress)}</span></Show>
      <Button icon="book" onClick={event => props.onOpen({ kind: 'reader', sourceId: props.doc.pageId }, event.shiftKey)}>Read</Button>
      <Button icon="more" label="Source actions" aria-haspopup="menu" onClick={event => sourceMenu(event.currentTarget)} />
    </div>
    <Show when={source.error}><p class="outline-capability-error" role="alert">{String(source.error)}</p></Show>
    <Show when={menu()}>{state => <Menu {...state()} onDismiss={() => setMenu(null)} />}</Show>
  </>;
}

/** Short source title and passage number; opens the reader at the cited range. */
export function CitationChip(props: { citation: Citation; notebook: NotebookClient; onOpen: OutlinePaneProps['onOpen'] }) {
  const title = () => shortSourceTitle(props.notebook.lookup(props.citation.source_id)()?.text ?? 'Source');
  return <Button class="outline-planning outline-citation" icon="quote" title={`Passage ${props.citation.ordinal + 1} · ${props.citation.locator}`} onClick={event => props.onOpen({
    kind: 'reader', sourceId: props.citation.source_id, snapshotId: props.citation.snapshot_id,
    at: props.citation.start.passage_id, citationId: props.citation.id,
  }, event.shiftKey)}>{title()} · ¶{props.citation.ordinal + 1}</Button>;
}
